// Irix: where in a Markdown file the text selected in its preview comes from. The preview is
// rendered HTML with no line markers, so the selection is found again in the source's text. Only
// letters and digits are compared: markup, bullets and spacing differ between the two.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import type { Nodes } from "mdast";
import { parseMarkdownPreviewDocument } from "@/file-panels/markdown-preview/document";

/** What the page gives for a selection: its text, and the text just before and after it. */
export interface PreviewSelection {
  selected: string;
  before: string;
  after: string;
}

export type SourceMapResult =
  | { status: "ok"; range: { startLine: number; endLine: number } }
  | { status: "not-found" }
  | { status: "ambiguous" };

const CONTEXT_LENGTH = 40;
const ANCHOR_LENGTH = 40;

interface SourceText {
  /** The source's letters and digits in reading order. */
  text: string;
  /** The 1-based source line of each character of `text`. */
  lines: number[];
}

function normalize(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, "");
}

function addRun(out: SourceText, value: string, firstLine: number): void {
  let line = firstLine;
  for (const char of value) {
    if (char === "\n") {
      line += 1;
      continue;
    }
    const kept = normalize(char);
    if (kept === "") continue;
    out.text += kept;
    for (let i = 0; i < kept.length; i += 1) out.lines.push(line);
  }
}

const FENCE = /^\s{0,3}(```|~~~)/;

function collect(node: Nodes, lineOffset: number, out: SourceText, bodyLines: string[]): void {
  const start = node.position?.start.line;
  if (start !== undefined) {
    if (node.type === "text" || node.type === "inlineCode") {
      addRun(out, node.value, start + lineOffset);
    } else if (node.type === "code") {
      // A fenced block's text starts on the line after the fence; an indented block has no fence.
      const fenceLines = FENCE.test(bodyLines[start - 1] ?? "") ? 1 : 0;
      addRun(out, node.value, start + lineOffset + fenceLines);
    }
  }
  if ("children" in node) {
    for (const child of node.children) collect(child as Nodes, lineOffset, out, bodyLines);
  }
}

function sourceText(source: string): SourceText {
  const { body } = parseMarkdownPreviewDocument(source);
  const prefix = source.slice(0, source.length - body.length);
  const lineOffset = prefix.split("\n").length - 1;
  const tree = fromMarkdown(body, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  const out: SourceText = { text: "", lines: [] };
  collect(tree, lineOffset, out, body.split("\n"));
  return out;
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at);
  }
  return found;
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

type Pick = { index: number } | "none" | "ambiguous";

/** The occurrence of `needle` whose surroundings are closest to what the page showed around it. */
function pick(source: SourceText, needle: string, before: string, after: string): Pick {
  const candidates = occurrences(source.text, needle);
  if (candidates.length === 0) return "none";
  if (candidates.length === 1) return { index: candidates[0] };
  let best = -1;
  let bestScore = -1;
  let tied = false;
  for (const index of candidates) {
    const score =
      commonSuffix(before, source.text.slice(Math.max(0, index - CONTEXT_LENGTH), index)) +
      commonPrefix(
        after,
        source.text.slice(index + needle.length, index + needle.length + CONTEXT_LENGTH),
      );
    if (score > bestScore) {
      best = index;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  return tied ? "ambiguous" : { index: best };
}

export function mapPreviewSelectionToSource(
  source: string,
  selection: PreviewSelection,
): SourceMapResult {
  const selected = normalize(selection.selected);
  if (selected === "") return { status: "not-found" };
  const before = normalize(selection.before).slice(-CONTEXT_LENGTH);
  const after = normalize(selection.after).slice(0, CONTEXT_LENGTH);
  const text = sourceText(source);

  const whole = pick(text, selected, before, after);
  if (whole === "ambiguous") return { status: "ambiguous" };
  if (whole !== "none") {
    return {
      status: "ok",
      range: {
        startLine: text.lines[whole.index],
        endLine: text.lines[whole.index + selected.length - 1],
      },
    };
  }

  // Characters the page shows that the source text lacks can sit in the middle of a selection.
  // The two ends alone are still enough to give its lines.
  if (selected.length <= ANCHOR_LENGTH) return { status: "not-found" };
  const head = pick(text, selected.slice(0, ANCHOR_LENGTH), before, "");
  const tail = pick(text, selected.slice(-ANCHOR_LENGTH), "", after);
  if (head === "ambiguous" || tail === "ambiguous") return { status: "ambiguous" };
  if (head === "none" || tail === "none" || tail.index < head.index) return { status: "not-found" };
  return {
    status: "ok",
    range: {
      startLine: text.lines[head.index],
      endLine: text.lines[tail.index + ANCHOR_LENGTH - 1],
    },
  };
}
