import { StringDecoder } from "node:string_decoder";
import type { Match } from "../shared/rpc.js";

export const LINE_WINDOW = 240;
const CONTEXT_BEFORE = 40;
const ELLIPSIS = "…";
/** Only the first matches of a line can be near the trim window; the rest are not converted. */
const MAX_SUBMATCHES_PER_LINE = 50;

export interface RgOutputParser {
  /** Matches completed by this chunk. */
  push(chunk: Buffer | string): Match[];
  /** Flush a trailing partial line. */
  end(): Match[];
}

interface Range {
  start: number;
  end: number;
}

interface RgData {
  path?: { text?: string; bytes?: string };
  lines?: { text?: string; bytes?: string };
  line_number?: number;
  submatches?: { start: number; end: number }[];
}

export function trimLineAroundMatch(
  line: string,
  ranges: Range[],
): { text: string; ranges: Range[] } {
  if (line.length <= LINE_WINDOW) return { text: line, ranges };
  const first = ranges.length > 0 ? ranges[0].start : 0;
  const winStart = Math.max(0, Math.min(first - CONTEXT_BEFORE, line.length - LINE_WINDOW));
  const winEnd = Math.min(line.length, winStart + LINE_WINDOW);
  const prefix = winStart > 0 ? ELLIPSIS : "";
  const suffix = winEnd < line.length ? ELLIPSIS : "";
  const shift = prefix.length - winStart;
  const kept: Range[] = [];
  for (const r of ranges) {
    // A match longer than the window is clamped to the visible text; only ranges that start
    // outside the window are dropped.
    if (r.start >= winStart && r.start < winEnd) {
      kept.push({ start: r.start + shift, end: Math.min(r.end, winEnd) + shift });
    }
  }
  return { text: prefix + line.slice(winStart, winEnd) + suffix, ranges: kept };
}

function decodeField(field: { text?: string; bytes?: string } | undefined): Buffer | null {
  if (!field) return null;
  if (typeof field.text === "string") return Buffer.from(field.text, "utf8");
  if (typeof field.bytes === "string") return Buffer.from(field.bytes, "base64");
  return null;
}

function parseMatch(raw: string): Match | null {
  let msg: { type?: string; data?: RgData };
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (msg.type !== "match" || !msg.data) return null;
  const { data } = msg;
  const pathBytes = decodeField(data.path);
  const lineBytes = decodeField(data.lines);
  if (!pathBytes || !lineBytes || typeof data.line_number !== "number") return null;

  const path = pathBytes.toString("utf8").replace(/\\/g, "/").replace(/^\.\//, "");
  // Submatches are sorted, so convert byte offsets to UTF-16 offsets in one forward pass,
  // decoding only the bytes between consecutive offsets.
  let bytePos = 0;
  let utf16Pos = 0;
  const toUtf16 = (byteOffset: number) => {
    if (byteOffset > bytePos) {
      utf16Pos += lineBytes.subarray(bytePos, byteOffset).toString("utf8").length;
      bytePos = byteOffset;
    }
    return utf16Pos;
  };

  // Byte length of the terminator to drop (\n or \r\n).
  let bodyEnd = lineBytes.length;
  if (bodyEnd > 0 && lineBytes[bodyEnd - 1] === 0x0a) bodyEnd -= 1;
  if (bodyEnd > 0 && lineBytes[bodyEnd - 1] === 0x0d) bodyEnd -= 1;
  const text = lineBytes.subarray(0, bodyEnd).toString("utf8");

  const ranges: Range[] = [];
  for (const s of (data.submatches ?? []).slice(0, MAX_SUBMATCHES_PER_LINE)) {
    const start = toUtf16(s.start);
    const end = Math.min(toUtf16(s.end), text.length);
    if (start < text.length || start === end) ranges.push({ start, end });
  }
  const column = (ranges[0]?.start ?? 0) + 1;
  const trimmed = trimLineAroundMatch(text, ranges);
  return { path, line: data.line_number, column, text: trimmed.text, ranges: trimmed.ranges };
}

/** Test hook: how many characters the parser searched for a newline. */
export interface RgOutputParserStats {
  scanned: number;
}

export function createRgOutputParser(stats?: RgOutputParserStats): RgOutputParser {
  const decoder = new StringDecoder("utf8");
  // The unfinished line, in the pieces it arrived in. Only new text is searched for a newline, so
  // a long line that arrives in many chunks is read once, not once per chunk.
  let pending: string[] = [];

  const parseLine = (line: string, out: Match[]) => {
    if (line.length === 0) return;
    const m = parseMatch(line);
    if (m) out.push(m);
  };

  const takeLine = (tail: string): string => {
    if (pending.length === 0) return tail;
    pending.push(tail);
    const line = pending.join("");
    pending = [];
    return line;
  };

  return {
    push(chunk) {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      const out: Match[] = [];
      let start = 0;
      let nl = text.indexOf("\n");
      while (nl !== -1) {
        if (stats) stats.scanned += nl + 1 - start;
        parseLine(takeLine(text.slice(start, nl)), out);
        start = nl + 1;
        nl = text.indexOf("\n", start);
      }
      if (stats) stats.scanned += text.length - start;
      if (start < text.length) pending.push(text.slice(start));
      return out;
    },
    end() {
      const out: Match[] = [];
      parseLine(takeLine(decoder.end()), out);
      return out;
    },
  };
}
