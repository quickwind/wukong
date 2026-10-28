// Irix: the comment extension for the CodeMirror views. It reads the latest context through a ref,
// so the one extension object lives as long as the view and the editor is never rebuilt.
import { useMemo, useRef } from "react";
import type { Extension } from "@codemirror/state";
import { useIrixFileCommentContext } from "./context";
import { irixFileCommentExtension } from "./editor-extension.web";

/** `isModified` tells whether the editor holds changes that are not saved; read-only views have none. */
export function useIrixFileComments(isModified: () => boolean = () => false): Extension {
  const context = useIrixFileCommentContext();
  const latest = useRef({ context, isModified });
  latest.current = { context, isModified };
  return useMemo(
    () =>
      irixFileCommentExtension(
        () => latest.current.context,
        () => latest.current.isModified(),
      ),
    [],
  );
}
