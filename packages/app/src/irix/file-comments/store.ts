// Irix: persisted drafts of file comments, one list per server and workspace.
import { useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { generateMessageId } from "@/types/stream";
import {
  addComment,
  capText,
  clearComments,
  deleteComment,
  FileCommentStateSchema,
  updateComment,
  type FileComment,
  type FileCommentState,
} from "./model";

const EMPTY_COMMENTS: FileComment[] = [];

// The browser keeps drafts in localStorage, about 5 MB for the whole origin. A send cuts the text
// further (format.ts); this keeps a select-all on a huge file from filling the storage.
const STORED_TEXT_LIMITS = { maxLines: 200, maxChars: 20_000 };

export type FileCommentInput = Omit<FileComment, "id" | "createdAt" | "updatedAt">;

const useFileCommentStore = create<FileCommentState>()(
  persist(() => ({ drafts: {} }), {
    name: "@irix:file-comment-store",
    version: 1,
    storage: createValidatedPersistStorage(AsyncStorage, FileCommentStateSchema),
    partialize: (state) => ({ drafts: state.drafts }),
  }),
);

export function useFileComments(key: string): FileComment[] {
  const comments = useFileCommentStore((state) => state.drafts[key]);
  return useMemo(() => comments ?? EMPTY_COMMENTS, [comments]);
}

export function getFileComments(key: string): FileComment[] {
  return useFileCommentStore.getState().drafts[key] ?? EMPTY_COMMENTS;
}

/** Calls `listener` after any change to the drafts; returns the unsubscribe function. */
export function subscribeFileComments(listener: () => void): () => void {
  return useFileCommentStore.subscribe(listener);
}

export function addFileComment(input: { key: string; comment: FileCommentInput }): FileComment {
  const now = new Date().toISOString();
  const comment: FileComment = {
    ...input.comment,
    lineText: capText(input.comment.lineText, STORED_TEXT_LIMITS).text,
    selectedText:
      input.comment.selectedText === null
        ? null
        : capText(input.comment.selectedText, STORED_TEXT_LIMITS).text,
    id: generateMessageId(),
    createdAt: now,
    updatedAt: now,
  };
  useFileCommentStore.setState((state) => addComment(state, { key: input.key, comment }));
  return comment;
}

export function updateFileComment(input: { key: string; id: string; body: string }): void {
  const updatedAt = new Date().toISOString();
  useFileCommentStore.setState((state) => updateComment(state, { ...input, updatedAt }));
}

export function deleteFileComment(input: { key: string; id: string }): void {
  useFileCommentStore.setState((state) => deleteComment(state, input));
}

/** Leaves comments added while the message was being sent. */
export function clearSentFileComments(input: {
  key: string;
  comments: readonly FileComment[];
}): void {
  const ids = input.comments.map((comment) => comment.id);
  useFileCommentStore.setState((state) => clearComments(state, { key: input.key, ids }));
}

export function resetFileCommentStore(): void {
  useFileCommentStore.setState({ drafts: {} });
}
