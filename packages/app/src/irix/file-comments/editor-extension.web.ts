// Irix: comments on lines in the CodeMirror file view. Click a line number (or drag, or
// Shift+click) or select text and press Comment; the comment shows under its lines.
import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  lineNumbers,
  showTooltip,
  type DecorationSet,
  type Tooltip,
} from "@codemirror/view";
import {
  buildFileCommentKey,
  lineRangeFromSelection,
  shouldReplaceDraft,
  type FileComment,
} from "./model";
import { registerOpenFile } from "./send";
import {
  addFileComment,
  deleteFileComment,
  getFileComments,
  subscribeFileComments,
  updateFileComment,
} from "./store";

import type { FileCommentContext } from "./context-value";

interface EditorDraft {
  startLine: number;
  endLine: number;
  selectedText: string | null;
  /** The comment being edited; null for a new one. */
  editingId: string | null;
  /** What the user has typed so far; kept here so scrolling the box away and back does not lose it. */
  body: string;
}

const openDraft = StateEffect.define<EditorDraft>();
const closeDraft = StateEffect.define<null>();
const editDraftBody = StateEffect.define<string>();
const commentsChanged = StateEffect.define<null>();

export function irixFileCommentExtension(
  getContext: () => FileCommentContext | null,
  isModified: () => boolean,
): Extension {
  const commentsOfFile = (): FileComment[] => {
    const context = getContext();
    if (!context) return [];
    return getFileComments(buildFileCommentKey(context)).filter(
      (comment) => comment.filePath === context.filePath,
    );
  };

  const draftField = StateField.define<EditorDraft | null>({
    create: () => null,
    update(value, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(openDraft)) return effect.value;
        if (effect.is(closeDraft)) return null;
        if (effect.is(editDraftBody) && value) return { ...value, body: effect.value };
      }
      return value;
    },
  });

  const threadField = StateField.define<DecorationSet>({
    create: (state) => buildThreads(state, commentsOfFile(), null, getContext),
    update(value, transaction) {
      const draftChanged =
        transaction.startState.field(draftField) !== transaction.state.field(draftField);
      const refreshed = transaction.effects.some((effect) => effect.is(commentsChanged));
      if (!transaction.docChanged && !draftChanged && !refreshed) return value;
      return buildThreads(
        transaction.state,
        commentsOfFile(),
        transaction.state.field(draftField),
        getContext,
      );
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  const selectionButton = StateField.define<Tooltip | null>({
    create: () => null,
    update(_value, transaction) {
      const { from, to } = transaction.state.selection.main;
      // Looks at the start of the selection only: a select-all on a huge file stays cheap.
      const start = transaction.state.sliceDoc(from, Math.min(to, from + 2000));
      if (start.trim() === "" || transaction.state.field(draftField)) return null;
      return {
        pos: to,
        above: false,
        create: () => ({ dom: commentButton() }),
      };
    },
    provide: (field) => showTooltip.from(field),
  });

  const markerGutter = gutter({
    class: "irix-comment-gutter",
    lineMarker(view, line) {
      const number = view.state.doc.lineAt(line.from).number;
      const covered = commentsOfFile().some(
        (comment) => comment.startLine <= number && number <= comment.endLine,
      );
      return covered ? new CommentMarker() : null;
    },
    lineMarkerChange: (update) =>
      update.transactions.some((tr) => tr.effects.some((e) => e.is(commentsChanged))),
    initialSpacer: () => new CommentMarker(),
  });

  const refreshOnStoreChange = ViewPlugin.define((view) => {
    const unsubscribe = subscribeFileComments(() => {
      view.dispatch({ effects: commentsChanged.of(null) });
    });
    return { destroy: unsubscribe };
  });

  // A send checks the comments of an open file against what the editor shows now.
  const registerOpen = ViewPlugin.define((view) => {
    const context = getContext();
    if (!context) return {};
    const unregister = registerOpenFile({
      ...context,
      read: () => ({
        lines: (start, end) =>
          end > view.state.doc.lines ? null : linesText(view.state, start, end),
        modified: isModified(),
      }),
    });
    return { destroy: unregister };
  });

  let anchorLine: number | null = null;
  const lineNumberClicks = lineNumbers({
    domEventHandlers: {
      mousedown(view, block, event) {
        if (!getContext() || !(event instanceof MouseEvent) || event.button !== 0) return false;
        if (!shouldReplaceDraft(view.state.field(draftField))) {
          view.dom.querySelector<HTMLTextAreaElement>(".irix-comment-input")?.focus();
          return true;
        }
        const line = view.state.doc.lineAt(block.from).number;
        const first = event.shiftKey && anchorLine !== null ? anchorLine : line;
        anchorLine = first;
        openRange(view, first, line);
        const onMove = (move: MouseEvent) => {
          const pos = view.posAtCoords({
            x: view.contentDOM.getBoundingClientRect().left + 1,
            y: move.clientY,
          });
          if (pos !== null) openRange(view, first, view.state.doc.lineAt(pos).number);
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        event.preventDefault();
        return true;
      },
    },
  });

  return [
    draftField,
    threadField,
    selectionButton,
    markerGutter,
    refreshOnStoreChange,
    registerOpen,
    lineNumberClicks,
    baseTheme,
  ];
}

function openRange(view: EditorView, a: number, b: number): void {
  const startLine = Math.min(a, b);
  const endLine = Math.max(a, b);
  view.dispatch({
    effects: openDraft.of({ startLine, endLine, selectedText: null, editingId: null, body: "" }),
  });
}

function commentButton(): HTMLElement {
  const button = document.createElement("button");
  button.className = "irix-comment-button";
  button.textContent = "Comment";
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const view = EditorView.findFromDOM(button.closest(".cm-editor") as HTMLElement);
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    if (selected.trim() === "") return;
    const { startLine, endLine } = lineRangeFromSelection(view.state.doc, from, to);
    view.dispatch({
      effects: openDraft.of({
        startLine,
        endLine,
        selectedText: selected,
        editingId: null,
        body: "",
      }),
    });
  });
  return button;
}

function linesText(state: EditorState, startLine: number, endLine: number): string {
  const doc = state.doc;
  const from = doc.line(startLine).from;
  const to = doc.line(endLine).to;
  return doc.sliceString(from, to).replace(/\r/g, "");
}

function buildThreads(
  state: EditorState,
  comments: FileComment[],
  draft: EditorDraft | null,
  getContext: () => FileCommentContext | null,
): DecorationSet {
  const entries: Array<{ line: number; widget: WidgetType; order: number }> = [];
  for (const comment of comments) {
    if (comment.endLine > state.doc.lines) continue;
    if (draft?.editingId === comment.id) continue;
    entries.push({
      line: comment.endLine,
      order: 0,
      widget: new CommentWidget(comment, getContext),
    });
  }
  if (draft && draft.endLine <= state.doc.lines) {
    entries.push({
      line: draft.endLine,
      order: 1,
      widget: new DraftWidget(draft, linesText(state, draft.startLine, draft.endLine), getContext),
    });
  }
  entries.sort((a, b) => a.line - b.line || a.order - b.order);
  const builder = new RangeSetBuilder<Decoration>();
  for (const entry of entries) {
    builder.add(
      state.doc.line(entry.line).to,
      state.doc.line(entry.line).to,
      Decoration.widget({ widget: entry.widget, block: true, side: 1 + entry.order }),
    );
  }
  return builder.finish();
}

class CommentMarker extends GutterMarker {
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "irix-comment-dot";
    return dot;
  }
}

class CommentWidget extends WidgetType {
  constructor(
    private readonly comment: FileComment,
    private readonly getContext: () => FileCommentContext | null,
  ) {
    super();
  }
  eq(other: CommentWidget) {
    return (
      other.comment.id === this.comment.id && other.comment.updatedAt === this.comment.updatedAt
    );
  }
  ignoreEvent() {
    return true;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "irix-comment-box";
    const range =
      this.comment.startLine === this.comment.endLine
        ? `Line ${this.comment.startLine}`
        : `Lines ${this.comment.startLine}-${this.comment.endLine}`;
    box.append(textElement("div", "irix-comment-meta", range));
    box.append(textElement("div", "irix-comment-body", this.comment.body));
    const actions = document.createElement("div");
    actions.className = "irix-comment-actions";
    const edit = textElement("button", "irix-comment-link", "Edit");
    edit.addEventListener("click", () => {
      view.dispatch({
        effects: openDraft.of({
          startLine: this.comment.startLine,
          endLine: this.comment.endLine,
          selectedText: this.comment.selectedText,
          editingId: this.comment.id,
          body: this.comment.body,
        }),
      });
    });
    const remove = textElement("button", "irix-comment-link", "Delete");
    remove.addEventListener("click", () => {
      const context = this.getContext();
      if (context) deleteFileComment({ key: buildFileCommentKey(context), id: this.comment.id });
    });
    actions.append(edit, remove);
    box.append(actions);
    return inSlot(box);
  }
}

class DraftWidget extends WidgetType {
  constructor(
    private readonly draft: EditorDraft,
    private readonly lineText: string,
    private readonly getContext: () => FileCommentContext | null,
  ) {
    super();
  }
  eq(other: DraftWidget) {
    return (
      other.draft.startLine === this.draft.startLine &&
      other.draft.endLine === this.draft.endLine &&
      other.draft.selectedText === this.draft.selectedText &&
      other.draft.editingId === this.draft.editingId
    );
  }
  ignoreEvent() {
    return true;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "irix-comment-box irix-comment-draft";
    const range =
      this.draft.startLine === this.draft.endLine
        ? `Line ${this.draft.startLine}`
        : `Lines ${this.draft.startLine}-${this.draft.endLine}`;
    box.append(textElement("div", "irix-comment-meta", range));
    const input = document.createElement("textarea");
    input.className = "irix-comment-input";
    input.placeholder = "Comment for the agent";
    input.rows = 3;
    input.value = this.draft.body;
    input.addEventListener("input", () => {
      view.dispatch({ effects: editDraftBody.of(input.value) });
    });
    const close = () => view.dispatch({ effects: closeDraft.of(null) });
    const save = () => {
      const body = input.value.trim();
      const context = this.getContext();
      if (!body || !context) return;
      const key = buildFileCommentKey(context);
      if (this.draft.editingId) {
        updateFileComment({ key, id: this.draft.editingId, body });
      } else {
        addFileComment({
          key,
          comment: {
            filePath: context.filePath,
            startLine: this.draft.startLine,
            endLine: this.draft.endLine,
            lineText: this.lineText,
            selectedText: this.draft.selectedText,
            body,
          },
        });
      }
      close();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
    });
    const actions = document.createElement("div");
    actions.className = "irix-comment-actions";
    const cancel = textElement("button", "irix-comment-link", "Cancel");
    cancel.addEventListener("click", close);
    const submit = textElement("button", "irix-comment-button", "Save");
    submit.addEventListener("click", save);
    actions.append(cancel, submit);
    box.append(input, actions);
    queueMicrotask(() => input.focus({ preventScroll: true }));
    return inSlot(box);
  }
}

/**
 * CodeMirror measures a block widget's height but not its margins, so the box's spacing is padding
 * on this outer element; a margin would push every line below it out of line with the gutter.
 */
function inSlot(box: HTMLElement): HTMLElement {
  const slot = document.createElement("div");
  slot.className = "irix-comment-slot";
  slot.append(box);
  return slot;
}

function textElement(tag: string, className: string, text: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

// Colors come from the editor's own text color, so the box follows the theme.
const baseTheme = EditorView.baseTheme({
  ".cm-lineNumbers .cm-gutterElement": { cursor: "pointer" },
  ".cm-lineNumbers .cm-gutterElement:hover": { color: "inherit", textDecoration: "underline" },
  ".irix-comment-gutter": { width: "10px" },
  ".irix-comment-dot": {
    display: "inline-block",
    width: "6px",
    height: "6px",
    marginLeft: "2px",
    borderRadius: "50%",
    backgroundColor: "currentColor",
    opacity: "0.7",
  },
  ".irix-comment-slot": { padding: "4px 16px 4px 56px" },
  ".irix-comment-box": {
    padding: "8px 10px",
    border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
    borderRadius: "6px",
    backgroundColor: "color-mix(in srgb, currentColor 6%, transparent)",
    fontFamily: "inherit",
    whiteSpace: "normal",
  },
  ".irix-comment-meta": { fontSize: "0.85em", opacity: "0.6", marginBottom: "4px" },
  ".irix-comment-body": { whiteSpace: "pre-wrap" },
  ".irix-comment-input": {
    width: "100%",
    boxSizing: "border-box",
    resize: "vertical",
    padding: "6px 8px",
    font: "inherit",
    color: "inherit",
    backgroundColor: "transparent",
    border: "1px solid color-mix(in srgb, currentColor 30%, transparent)",
    borderRadius: "4px",
  },
  ".irix-comment-actions": {
    display: "flex",
    gap: "12px",
    justifyContent: "flex-end",
    marginTop: "6px",
  },
  ".irix-comment-link": {
    background: "none",
    border: "none",
    color: "inherit",
    opacity: "0.7",
    cursor: "pointer",
    font: "inherit",
    padding: 0,
  },
  ".irix-comment-button": {
    font: "inherit",
    color: "inherit",
    cursor: "pointer",
    padding: "2px 10px",
    borderRadius: "4px",
    border: "1px solid color-mix(in srgb, currentColor 40%, transparent)",
    backgroundColor: "color-mix(in srgb, currentColor 10%, transparent)",
  },
});
