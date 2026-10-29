import { execFile } from "node:child_process";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReplaceFile, ReplaceFileResult, ReplaceInput } from "../shared/rpc.js";
import { buildRgReplaceArgs } from "./rg-args.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_RG_OUTPUT = 256 * 1024 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const CHANGED = "Changed on disk since the search";

interface Edit {
  start: number;
  end: number;
  expected: Buffer;
  replacement: Buffer;
}

interface RgField {
  text?: string;
  bytes?: string;
}

interface RgMatchData {
  line_number?: number;
  submatches?: { match: RgField; replacement?: RgField; start: number; end: number }[];
}

function field(value: RgField | undefined): Buffer | null {
  if (!value) return null;
  if (typeof value.text === "string") return Buffer.from(value.text, "utf8");
  if (typeof value.bytes === "string") return Buffer.from(value.bytes, "base64");
  return null;
}

function skipped(file: string, reason: string): ReplaceFileResult {
  return { path: file, status: "skipped", count: 0, reason };
}

function runRg(rg: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      rg,
      args,
      { cwd, windowsHide: true, maxBuffer: MAX_RG_OUTPUT, encoding: "utf8" },
      (error, stdout, stderr) => {
        // Exit 1 is "no matches"; ripgrep's own message for an error is on stderr.
        const code = (error as { code?: unknown } | null)?.code;
        if (error && code !== 1) reject(new Error(String(stderr).trim() || error.message));
        else resolve(stdout);
      },
    );
  });
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Start offsets (in the file's bytes) of the wanted 1-based lines; a line ends at a line feed. */
function lineStarts(buffer: Buffer, bomLength: number, wanted: Set<number>): Map<number, number> {
  const starts = new Map<number, number>();
  const last = Math.max(...wanted);
  let line = 1;
  let offset = bomLength;
  if (wanted.has(1)) starts.set(1, offset);
  while (line < last) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline === -1) break;
    offset = newline + 1;
    line += 1;
    if (wanted.has(line)) starts.set(line, offset);
  }
  return starts;
}

/** The file's real path when it is a file inside the folder; otherwise why not. */
async function resolveFile(root: string, name: string): Promise<string | ReplaceFileResult> {
  const parts = name.split("/");
  if (path.isAbsolute(name) || parts.includes("..") || parts.includes(".git")) {
    return skipped(name, "Not a file in this workspace");
  }
  let absolute: string;
  try {
    absolute = await realpath(path.join(root, ...parts));
  } catch {
    return skipped(name, "The file is gone");
  }
  if (!isInside(root, absolute)) return skipped(name, "Not a file in this workspace");
  return absolute;
}

/** Reads ripgrep's matches on the wanted lines as byte edits, or null if the file is not as searched. */
function collectEdits(output: string, buffer: Buffer, wanted: Set<number>): Edit[] | null {
  const bomLength = buffer.subarray(0, 3).equals(UTF8_BOM) ? 3 : 0;
  const starts = lineStarts(buffer, bomLength, wanted);
  const edits: Edit[] = [];
  const seen = new Set<number>();
  for (const raw of output.split(String.fromCharCode(10))) {
    if (!raw.startsWith('{"type":"match"')) continue;
    const data = (JSON.parse(raw) as { data: RgMatchData }).data;
    const base = data.line_number === undefined ? undefined : starts.get(data.line_number);
    if (data.line_number === undefined || base === undefined) continue;
    seen.add(data.line_number);
    for (const sub of data.submatches ?? []) {
      const expected = field(sub.match);
      if (!expected) return null;
      const replacement = field(sub.replacement) ?? Buffer.alloc(0);
      edits.push({ start: base + sub.start, end: base + sub.end, expected, replacement });
    }
  }
  // A line the search found that no longer matches means the file is not what the user saw.
  return seen.size === wanted.size ? edits : null;
}

/** The buffer with the edits applied, or null if any edit does not sit on the text it expects. */
function applyEdits(buffer: Buffer, edits: Edit[]): Buffer | null {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const pieces: Buffer[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor || !buffer.subarray(edit.start, edit.end).equals(edit.expected)) {
      return null;
    }
    pieces.push(buffer.subarray(cursor, edit.start), edit.replacement);
    cursor = edit.end;
  }
  pieces.push(buffer.subarray(cursor));
  return Buffer.concat(pieces);
}

function isUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

async function replaceInFile(
  rg: string,
  root: string,
  input: ReplaceInput,
  file: ReplaceFile,
): Promise<ReplaceFileResult> {
  const name = file.path;
  const absolute = await resolveFile(root, name);
  if (typeof absolute !== "string") return absolute;

  const before = await stat(absolute);
  if (!before.isFile()) return skipped(name, "Not a file");
  if (before.mtimeMs !== file.mtimeMs || before.size !== file.size) return skipped(name, CHANGED);
  if (before.size > MAX_FILE_BYTES) return skipped(name, "The file is too large to replace in");

  const buffer = await readFile(absolute);
  if (!isUtf8(buffer)) return skipped(name, "Not a UTF-8 file");

  const output = await runRg(rg, buildRgReplaceArgs(input, path.relative(root, absolute)), root);
  const edits = collectEdits(output, buffer, new Set(file.lines));
  const updated = edits && applyEdits(buffer, edits);
  if (!edits || !updated) return skipped(name, CHANGED);

  // Last look before writing: anyone who saved since our read wins.
  const latest = await stat(absolute);
  if (latest.mtimeMs !== before.mtimeMs || latest.size !== before.size) {
    return skipped(name, CHANGED);
  }
  await writeFile(absolute, updated);
  return { path: name, status: "replaced", count: edits.length, reason: null };
}

/**
 * Replaces on the given lines of each file. A file that changed, is not UTF-8 or fails any check
 * is left untouched and reported; the other files are still replaced.
 */
export async function replaceInFiles(
  rgPath: string,
  input: ReplaceInput,
): Promise<ReplaceFileResult[]> {
  const root = await realpath(path.resolve(input.cwd));
  const results: ReplaceFileResult[] = [];
  for (const file of input.files) {
    try {
      results.push(await replaceInFile(rgPath, root, input, file));
    } catch (error) {
      results.push(skipped(file.path, error instanceof Error ? error.message : String(error)));
    }
  }
  return results;
}
