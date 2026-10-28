// Irix: comments on the rendered Markdown preview. The page has no line markers, so a selection is
// found again in the source (markdown-source-map.ts) and the comment is kept for those lines, like
// one made in the source view. HTML previews run in a sandboxed frame we cannot read; they only
// get a pointer to the source view.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useFileText } from "@getpaseo/plugin/client";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
} from "@/workspace/file-open";
import { FOCUSED_PANE_PLACEMENT, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { floatingPlacement } from "./float-position";
import { mapPreviewSelectionToSource, type SourceMapResult } from "./markdown-source-map";
import { buildFileCommentKey, type FileComment } from "./model";
import type { PreviewCommentsProps } from "./preview-comments";
import { addFileComment, deleteFileComment, updateFileComment, useFileComments } from "./store";

export type { PreviewCommentsProps } from "./preview-comments";

const MARKDOWN_PREVIEW = '[data-testid="markdown-preview-frame"]';
const HTML_PREVIEW = '[data-testid="file-html-preview"]';

function extensionOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

export function PreviewComments(props: PreviewCommentsProps) {
  const extension = extensionOf(props.filePath);
  if (extension === "md" || extension === "markdown") return <MarkdownPreviewComments {...props} />;
  if (extension === "html" || extension === "htm") return <HtmlPreviewNotice />;
  return null;
}

/** The host element of the panel, and whether `selector` is showing inside it right now. */
function usePreviewElement(selector: string) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [preview, setPreview] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const element = anchorRef.current?.parentElement ?? null;
    setHost(element);
    if (!element) return;
    const look = () => setPreview(element.querySelector<HTMLElement>(selector));
    look();
    const observer = new MutationObserver(look);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [selector]);
  return { anchorRef, host, preview };
}

function HtmlPreviewNotice() {
  const { anchorRef, preview } = usePreviewElement(HTML_PREVIEW);
  return (
    <>
      <div ref={anchorRef} style={ANCHOR_STYLE} />
      {preview ? (
        <View style={styles.notice} pointerEvents="none">
          <Text style={styles.noticeText}>To comment on this file, switch to Source.</Text>
        </View>
      ) : null}
    </>
  );
}

interface SelectionState {
  selected: string;
  before: string;
  after: string;
  rectLeft: number;
  rectTop: number;
  rectBottom: number;
}

function MarkdownPreviewComments({ serverId, workspaceId, filePath, file }: PreviewCommentsProps) {
  const { anchorRef, host, preview } = usePreviewElement(MARKDOWN_PREVIEW);
  const text = useFileText(file);
  const source = text.status === "ready" ? text.text : null;
  const key = buildFileCommentKey({ serverId, workspaceId });
  const comments = useFileComments(key).filter((comment) => comment.filePath === filePath);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [draft, setDraft] = useState<{ selection: SelectionState; result: SourceMapResult } | null>(
    null,
  );

  useEffect(() => {
    if (!host || !preview) {
      setSelection(null);
      return;
    }
    const read = () => setSelection(readSelection(preview));
    const onMouseUp = (event: Event) => {
      // A press on the floating button or panel is not a new selection.
      if (event.target instanceof Node && preview.contains(event.target)) setTimeout(read, 0);
    };
    host.addEventListener("mouseup", onMouseUp);
    host.addEventListener("keyup", onMouseUp);
    return () => {
      host.removeEventListener("mouseup", onMouseUp);
      host.removeEventListener("keyup", onMouseUp);
    };
  }, [host, preview]);

  const openDraft = useCallback(() => {
    if (!selection || source === null) return;
    setDraft({ selection, result: mapPreviewSelectionToSource(source, selection) });
    setSelection(null);
  }, [selection, source]);
  const closeDraft = useCallback(() => setDraft(null), []);

  const save = useCallback(
    (body: string) => {
      if (!draft || draft.result.status !== "ok" || source === null) return;
      const { startLine, endLine } = draft.result.range;
      addFileComment({
        key,
        comment: {
          filePath,
          startLine,
          endLine,
          lineText: source
            .split("\n")
            .slice(startLine - 1, endLine)
            .join("\n")
            .replace(/\r/g, ""),
          selectedText: draft.selection.selected.trim(),
          body,
        },
      });
      setDraft(null);
    },
    [draft, filePath, key, source],
  );

  const showInSource = useCallback(
    (comment: FileComment) => {
      const location = normalizeWorkspaceFileLocation({
        path: filePath,
        lineStart: comment.startLine,
        lineEnd: comment.endLine,
      });
      const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
      if (!location || !workspaceKey) return;
      useWorkspaceLayoutStore.getState().openTab({
        workspaceKey,
        target: createWorkspaceFileTabTarget(location),
        intent: "reveal",
        placement: FOCUSED_PANE_PLACEMENT,
      });
    },
    [filePath, serverId, workspaceId],
  );

  return (
    <>
      <div ref={anchorRef} style={ANCHOR_STYLE} />
      {preview && selection ? (
        <FloatingAt anchor={selection} width={BUTTON_WIDTH} height={BUTTON_HEIGHT}>
          <View style={styles.solid}>
            <Button variant="outline" size="sm" onPress={openDraft}>
              Comment
            </Button>
          </View>
        </FloatingAt>
      ) : null}
      {preview && draft ? (
        <FloatingAt anchor={draft.selection} width={PANEL_WIDTH} height={PANEL_HEIGHT}>
          <DraftPanel
            selected={draft.selection.selected}
            result={draft.result}
            onSave={save}
            onCancel={closeDraft}
          />
        </FloatingAt>
      ) : null}
      {preview && comments.length > 0 ? (
        <CommentList comments={comments} keyOfDraft={key} onShowInSource={showInSource} />
      ) : null}
    </>
  );
}

function readSelection(preview: HTMLElement): SelectionState | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!preview.contains(range.commonAncestorContainer)) return null;
  const selected = selection.toString();
  if (selected.trim() === "") return null;
  const before = document.createRange();
  before.selectNodeContents(preview);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.selectNodeContents(preview);
  after.setStart(range.endContainer, range.endOffset);
  const rect = range.getBoundingClientRect();
  return {
    selected,
    before: before.toString(),
    after: after.toString(),
    rectLeft: rect.left,
    rectTop: rect.top,
    rectBottom: rect.bottom,
  };
}

// Sizes the placement leaves room for; the panel grows with its text, so its height is generous.
const BUTTON_WIDTH = 110;
const BUTTON_HEIGHT = 40;
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 280;

function FloatingAt({
  anchor,
  width,
  height,
  children,
}: {
  anchor: SelectionState;
  width: number;
  height: number;
  children: ReactNode;
}) {
  const { rectLeft, rectTop, rectBottom } = anchor;
  const style = useMemo(
    () => [
      styles.floating,
      { width },
      floatingPlacement({
        rectLeft,
        rectTop,
        rectBottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        width,
        height,
      }),
    ],
    [height, rectBottom, rectLeft, rectTop, width],
  );
  return <View style={style}>{children}</View>;
}

function DraftPanel({
  selected,
  result,
  onSave,
  onCancel,
}: {
  selected: string;
  result: SourceMapResult;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const submit = useCallback(() => {
    if (body.trim()) onSave(body.trim());
  }, [body, onSave]);
  if (result.status !== "ok") {
    return (
      <View style={styles.panel}>
        <Text style={styles.panelText}>
          {result.status === "ambiguous"
            ? "This text appears more than once. Select a longer passage to comment on it."
            : "Could not find this text in the source. Switch to Source to comment on it."}
        </Text>
        <View style={styles.actions}>
          <Button variant="ghost" size="sm" onPress={onCancel}>
            Close
          </Button>
        </View>
      </View>
    );
  }
  const { startLine, endLine } = result.range;
  const label = startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}-${endLine}`;
  return (
    <View style={styles.panel}>
      <Text style={styles.meta}>{label}</Text>
      <Text style={styles.quote} numberOfLines={3}>
        {selected.trim()}
      </Text>
      <AdaptiveTextInput
        style={styles.input}
        initialValue=""
        onChangeText={setBody}
        placeholder="Comment for the agent"
        multiline
        numberOfLines={3}
        autoFocus
      />
      <View style={styles.actions}>
        <Button variant="ghost" size="sm" onPress={onCancel}>
          Cancel
        </Button>
        <Button variant="default" size="sm" onPress={submit}>
          Save
        </Button>
      </View>
    </View>
  );
}

function CommentList({
  comments,
  keyOfDraft,
  onShowInSource,
}: {
  comments: FileComment[];
  keyOfDraft: string;
  onShowInSource: (comment: FileComment) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <View style={styles.list}>
      {open ? (
        <ScrollView style={styles.listBody} contentContainerStyle={styles.listContent}>
          {comments.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              storeKey={keyOfDraft}
              onShowInSource={onShowInSource}
            />
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.solid}>
        <Button variant="outline" size="sm" onPress={toggle}>
          {`${comments.length} ${comments.length === 1 ? "comment" : "comments"} on this file`}
        </Button>
      </View>
    </View>
  );
}

function CommentRow({
  comment,
  storeKey,
  onShowInSource,
}: {
  comment: FileComment;
  storeKey: string;
  onShowInSource: (comment: FileComment) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const label =
    comment.startLine === comment.endLine
      ? `Line ${comment.startLine}`
      : `Lines ${comment.startLine}-${comment.endLine}`;
  const quote = (comment.selectedText ?? comment.lineText).split("\n")[0];
  const edit = useCallback(() => setEditing(true), []);
  const stopEditing = useCallback(() => {
    setBody(comment.body);
    setEditing(false);
  }, [comment.body]);
  const save = useCallback(() => {
    if (body.trim()) updateFileComment({ key: storeKey, id: comment.id, body: body.trim() });
    setEditing(false);
  }, [body, comment.id, storeKey]);
  const remove = useCallback(
    () => deleteFileComment({ key: storeKey, id: comment.id }),
    [comment.id, storeKey],
  );
  const show = useCallback(() => onShowInSource(comment), [comment, onShowInSource]);
  return (
    <View style={styles.row}>
      <Text style={styles.meta}>{label}</Text>
      <Text style={styles.quote} numberOfLines={1}>
        {quote}
      </Text>
      {editing ? (
        <AdaptiveTextInput
          style={styles.input}
          initialValue={comment.body}
          onChangeText={setBody}
          multiline
          autoFocus
        />
      ) : (
        <Text style={styles.panelText}>{comment.body}</Text>
      )}
      <View style={styles.actions}>
        {editing ? (
          <>
            <Button variant="ghost" size="sm" onPress={stopEditing}>
              Cancel
            </Button>
            <Button variant="ghost" size="sm" onPress={save}>
              Save
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onPress={show}>
              Show in Source
            </Button>
            <Button variant="ghost" size="sm" onPress={edit}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" onPress={remove}>
              Delete
            </Button>
          </>
        )}
      </View>
    </View>
  );
}

const ANCHOR_STYLE = { display: "none" } as const;

const styles = StyleSheet.create((theme) => ({
  // `fixed` places the box by the selection's viewport rectangle; the type only knows `absolute`.
  floating: { position: "fixed" as "absolute", zIndex: 50 },
  // The outline button has no fill of its own, so it sits on this to keep the text behind it out.
  solid: {
    alignSelf: "flex-start",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  panel: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  panelText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  quote: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, fontStyle: "italic" },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    minHeight: 64,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actions: { flexDirection: "row", gap: theme.spacing[3], justifyContent: "flex-end" },
  link: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  list: {
    position: "absolute",
    right: theme.spacing[4],
    // Above the send button, which sits along the bottom edge whenever there are comments.
    bottom: theme.spacing[4] + 48,
    maxWidth: 420,
    alignItems: "flex-end",
    gap: theme.spacing[2],
  },
  listContent: { gap: theme.spacing[3] },
  listBody: {
    maxHeight: 320,
    flexGrow: 0,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  row: { gap: theme.spacing[1] },
  notice: {
    position: "absolute",
    right: theme.spacing[4],
    bottom: theme.spacing[4],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  noticeText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
