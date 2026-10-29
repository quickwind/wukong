import type { Match, ReplaceFile, ReplaceResult } from "./content-search";
import type { FileGroup } from "./content-search-state";

/** A result row, by file and line: the unit the user keeps or leaves out of a replace. */
export function matchKey(match: Pick<Match, "path" | "line">): string {
  return `${match.path}:${match.line}`;
}

export interface ReplacePlan {
  files: ReplaceFile[];
  /** Result rows that will be replaced. */
  matchCount: number;
  /** Files with a match the search did not record a version for; they cannot be checked. */
  unversioned: string[];
}

/** What a replace would write: every shown line the user has not left out. */
export function planReplace(
  groups: readonly FileGroup[],
  excludedMatches: ReadonlySet<string>,
  excludedFiles: ReadonlySet<string>,
): ReplacePlan {
  const files: ReplaceFile[] = [];
  const unversioned: string[] = [];
  let matchCount = 0;
  for (const group of groups) {
    if (excludedFiles.has(group.path)) continue;
    const kept = group.matches.filter((match) => !excludedMatches.has(matchKey(match)));
    if (kept.length === 0) continue;
    const { mtimeMs, size } = kept[0];
    if (mtimeMs === undefined || size === undefined) {
      unversioned.push(group.path);
      continue;
    }
    files.push({ path: group.path, mtimeMs, size, lines: [...new Set(kept.map((m) => m.line))] });
    matchCount += kept.length;
  }
  return { files, matchCount, unversioned };
}

export interface ReplaceSummary {
  replacedMatches: number;
  replacedFiles: number;
  skipped: { path: string; reason: string }[];
}

export function summarizeReplace(results: readonly ReplaceResult[]): ReplaceSummary {
  const summary: ReplaceSummary = { replacedMatches: 0, replacedFiles: 0, skipped: [] };
  for (const result of results) {
    if (result.status === "replaced") {
      summary.replacedMatches += result.count;
      summary.replacedFiles += 1;
    } else {
      summary.skipped.push({ path: result.path, reason: result.reason ?? "Skipped" });
    }
  }
  return summary;
}

/** One line for the status area after a replace. */
export function describeReplace(summary: ReplaceSummary): string {
  const occurrences =
    summary.replacedMatches === 1 ? "1 match" : `${summary.replacedMatches} matches`;
  const files = summary.replacedFiles === 1 ? "1 file" : `${summary.replacedFiles} files`;
  const done = `Replaced ${occurrences} in ${files}.`;
  if (summary.skipped.length === 0) return done;
  const left = summary.skipped.length === 1 ? "1 file" : `${summary.skipped.length} files`;
  return `${done} ${left} left alone.`;
}

export interface PreviewSegment {
  /** Position in the line, so the segments can be keyed. */
  id: number;
  kind: "keep" | "old" | "new";
  text: string;
}

/** A line with each match struck out and the replacement after it, as the user would get it. */
export function previewSegments(
  text: string,
  ranges: readonly { start: number; end: number }[],
  replacement: string,
): PreviewSegment[] {
  const segments: PreviewSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(range.start, cursor);
    const end = Math.min(Math.max(range.end, start), text.length);
    if (end <= start) continue;
    if (start > cursor)
      segments.push({ id: cursor, kind: "keep", text: text.slice(cursor, start) });
    segments.push({ id: start, kind: "old", text: text.slice(start, end) });
    if (replacement.length > 0) segments.push({ id: -start - 1, kind: "new", text: replacement });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ id: cursor, kind: "keep", text: text.slice(cursor) });
  return segments;
}
