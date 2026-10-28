// Irix: what a send takes along from the file comments of a workspace.
import type { ComposerAttachment } from "@/attachments/types";
import { formatFileCommentsAttachment } from "./format";
import { buildFileCommentKey } from "./model";
import { clearSentFileComments, getFileComments } from "./store";

interface OpenFileReader {
  /** The lines `start..end` (1-based) as they are shown now, or null past the end. */
  lines(start: number, end: number): string | null;
  /** The editor holds changes that are not saved. */
  modified: boolean;
}

const openFiles = new Map<string, () => OpenFileReader>();

function openFileKey(input: { serverId: string; workspaceId: string; filePath: string }): string {
  return `${buildFileCommentKey(input)}:${input.filePath}`;
}

/** A file view registers while it shows the file, so a send can check its comments against it. */
export function registerOpenFile(input: {
  serverId: string;
  workspaceId: string;
  filePath: string;
  read: () => OpenFileReader;
}): () => void {
  const key = openFileKey(input);
  openFiles.set(key, input.read);
  return () => {
    if (openFiles.get(key) === input.read) openFiles.delete(key);
  };
}

/**
 * `dispatchComposerAgentMessage` takes composer attachments. A chat_history one hands its text
 * attachment to the wire untouched, so the file comments carry through without a new kind.
 */
export function takeFileCommentsForSend(
  serverId: string,
  workspaceId: string | undefined,
): {
  attachments: ComposerAttachment[];
  clearSent: () => void;
} {
  const input = { serverId, workspaceId: workspaceId ?? "" };
  const key = buildFileCommentKey(input);
  const comments = getFileComments(key);
  const modifiedPaths = new Set<string>();
  const driftedIds = new Set<string>();
  const uncheckedIds = new Set<string>();
  for (const comment of comments) {
    const read = openFiles.get(openFileKey({ ...input, filePath: comment.filePath }));
    if (!read) {
      uncheckedIds.add(comment.id);
      continue;
    }
    const file = read();
    if (file.modified) modifiedPaths.add(comment.filePath);
    if (file.lines(comment.startLine, comment.endLine) !== comment.lineText) {
      driftedIds.add(comment.id);
    }
  }
  const attachment = formatFileCommentsAttachment({
    comments,
    modifiedPaths,
    driftedIds,
    uncheckedIds,
  });
  return {
    attachments: attachment
      ? [
          {
            kind: "chat_history",
            id: `irix-file-comments:${key}`,
            attachment,
            source: { serverId: input.serverId, agentId: "" },
          },
        ]
      : [],
    clearSent: () => clearSentFileComments({ key, comments }),
  };
}
