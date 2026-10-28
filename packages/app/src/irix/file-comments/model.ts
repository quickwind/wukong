// Irix: comments on lines of a file in the file view. Pure state; no React, no CodeMirror.
import { z } from "zod";

export interface FileComment {
  id: string;
  filePath: string;
  /** 1-based, `startLine <= endLine`. */
  startLine: number;
  endLine: number;
  /** The commented lines as they were when the comment was written, without `\r`. */
  lineText: string;
  /** The words the user selected; null for a comment made from the line number. */
  selectedText: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileCommentState {
  drafts: Record<string, FileComment[]>;
}

const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const FileCommentSchema: z.ZodType<FileComment> = z.strictObject({
  id: z.string(),
  filePath: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  lineText: z.string(),
  selectedText: z.string().nullable(),
  body: z.string(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const FileCommentStateSchema: z.ZodType<FileCommentState> = z.strictObject({
  drafts: z.record(z.string(), z.array(FileCommentSchema)),
});

export function buildFileCommentKey(input: { serverId: string; workspaceId: string }): string {
  return `${input.serverId}:${input.workspaceId}`;
}

export function addComment(
  state: FileCommentState,
  input: { key: string; comment: FileComment },
): FileCommentState {
  return {
    drafts: { ...state.drafts, [input.key]: [...(state.drafts[input.key] ?? []), input.comment] },
  };
}

export function updateComment(
  state: FileCommentState,
  input: { key: string; id: string; body: string; updatedAt: string },
): FileCommentState {
  const comments = state.drafts[input.key] ?? [];
  if (!comments.some((comment) => comment.id === input.id)) return state;
  return {
    drafts: {
      ...state.drafts,
      [input.key]: comments.map((comment) => withBody(comment, input)),
    },
  };
}

function withBody(
  comment: FileComment,
  input: { id: string; body: string; updatedAt: string },
): FileComment {
  if (comment.id !== input.id) return comment;
  return {
    id: comment.id,
    filePath: comment.filePath,
    startLine: comment.startLine,
    endLine: comment.endLine,
    lineText: comment.lineText,
    selectedText: comment.selectedText,
    body: input.body,
    createdAt: comment.createdAt,
    updatedAt: input.updatedAt,
  };
}

export function deleteComment(
  state: FileCommentState,
  input: { key: string; id: string },
): FileCommentState {
  return clearComments(state, { key: input.key, ids: [input.id] });
}

export function clearComments(
  state: FileCommentState,
  input: { key: string; ids: readonly string[] },
): FileCommentState {
  const comments = state.drafts[input.key];
  if (!comments?.some((comment) => input.ids.includes(comment.id))) return state;
  const kept = comments.filter((comment) => !input.ids.includes(comment.id));
  const drafts = { ...state.drafts };
  if (kept.length === 0) delete drafts[input.key];
  else drafts[input.key] = kept;
  return { drafts };
}

interface LineLookup {
  lineAt(pos: number): { number: number; from: number };
}

/** A selection that ends at the start of a line does not include that line. */
export function lineRangeFromSelection(
  doc: LineLookup,
  from: number,
  to: number,
): { startLine: number; endLine: number } {
  const startLine = doc.lineAt(from).number;
  if (to <= from) return { startLine, endLine: startLine };
  const end = doc.lineAt(to);
  const endLine = to === end.from ? doc.lineAt(to - 1).number : end.number;
  return { startLine, endLine: Math.max(startLine, endLine) };
}

export function capText(
  text: string,
  limits: { maxLines: number; maxChars: number },
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  let capped = lines.slice(0, limits.maxLines).join("\n");
  let truncated = lines.length > limits.maxLines;
  if (capped.length > limits.maxChars) {
    capped = capped.slice(0, limits.maxChars);
    truncated = true;
  }
  return { text: capped, truncated };
}

/** A click on another line number must not wipe a comment the user has started to write. */
export function shouldReplaceDraft(current: { body: string } | null): boolean {
  return current === null || current.body.trim() === "";
}
