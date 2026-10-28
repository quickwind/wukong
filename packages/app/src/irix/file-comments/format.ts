// Irix: file comments as the text an agent reads. The first line tells them apart from the diff's
// "Paseo review attachment".
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { capText, type FileComment } from "./model";

export const FILE_COMMENT_ATTACHMENT_TITLE = "Paseo file comment attachment";

const LIMITS = { maxLines: 50, maxChars: 4000 };
const UNSAVED_NOTE =
  "Note: the file has unsaved changes; line numbers refer to the editor content, not the file on disk.";
const UNCHECKED_NOTE =
  "Note: the file was not open when this was sent, so the line numbers were not checked against it; the commented text below is what the user saw.";
const DRIFT_NOTE =
  "Note: the file changed since this comment was written; the line numbers may be off, the commented text below is what the user saw.";

export function formatFileCommentsAttachment(input: {
  comments: readonly FileComment[];
  /** Paths of files whose editor holds changes that are not saved. */
  modifiedPaths: ReadonlySet<string>;
  driftedIds: ReadonlySet<string>;
  /** Comments of files that were not open to check their lines against. */
  uncheckedIds: ReadonlySet<string>;
}): Extract<AgentAttachment, { type: "text" }> | null {
  if (input.comments.length === 0) return null;
  const blocks = input.comments.map((comment, index) => formatComment(comment, index, input));
  return {
    type: "text",
    mimeType: "text/plain",
    title: FILE_COMMENT_ATTACHMENT_TITLE,
    text: [FILE_COMMENT_ATTACHMENT_TITLE, ...blocks.map((block) => `\n${block}`)].join("\n"),
  };
}

function formatComment(
  comment: FileComment,
  index: number,
  input: {
    modifiedPaths: ReadonlySet<string>;
    driftedIds: ReadonlySet<string>;
    uncheckedIds: ReadonlySet<string>;
  },
): string {
  const range =
    comment.startLine === comment.endLine
      ? `${comment.startLine}`
      : `${comment.startLine}-${comment.endLine}`;
  const lines = [`Comment ${index + 1}: ${comment.filePath}:${range}`];
  if (input.modifiedPaths.has(comment.filePath)) lines.push(UNSAVED_NOTE);
  if (input.driftedIds.has(comment.id)) lines.push(DRIFT_NOTE);
  if (input.uncheckedIds.has(comment.id)) lines.push(UNCHECKED_NOTE);
  if (comment.selectedText !== null) {
    const selected = capText(comment.selectedText, LIMITS);
    lines.push(`Selected text: ${selected.text}${selected.truncated ? " [truncated]" : ""}`);
  }
  const commented = capText(comment.lineText, LIMITS);
  lines.push("Commented lines:", ...commented.text.split("\n").map((line) => `> ${line}`));
  if (commented.truncated) lines.push("[truncated]");
  lines.push(comment.body);
  return lines.join("\n");
}
