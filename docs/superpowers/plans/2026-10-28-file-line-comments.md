# Comments on Lines of a File: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comment on one or several lines in the file view (web), with line numbers, and send the comments to an agent together with diff comments.

**Architecture:** The store, the formatting and the UI of the comments live in new files under `packages/app/src/irix/file-comments/`. Upstream files get a few lines each: they hook the Irix CodeMirror extension into the two source views and make the diff's send take the file comments along. File comments go as the existing `text` attachment; the server and the protocol are not touched.

**Tech Stack:** TypeScript, CodeMirror 6, zustand + AsyncStorage, vitest (the app package's test environment is node, there is no DOM).

**Spec:** `docs/superpowers/specs/2026-10-28-file-line-comments-design.md`

## Status and deviations from this plan

The plan was executed in the order 1, 2, 3, 4, 5, 7, 6, 8, 9. The task text below is the original plan; where the code differs, this is what changed:

- **Task 5.** `takeFileCommentsForSend(serverId, workspaceId: string | undefined)` takes positional arguments (so the call fits on one line) and returns `ComposerAttachment[]`: `dispatchComposerAgentMessage` only accepts composer attachments, and a `chat_history` one passes its text attachment to the wire untouched, so that is the carrier.
- **Task 6.** The wiring is in `file-panels/builtin.tsx` (`BuiltinFilePanelView`, one choke point for every built-in panel), not in `source/panel.tsx`. There is no `IrixFileCommentsProvider` with a `modified` prop: `withIrixFileComments(props, children)` in `context.tsx` renders the context host, the send button and the preview comments; `useIrixFileComments(isModified?)` (in `use-extension.web.ts`) takes a function that tells whether the editor has unsaved changes. `registerOpenFile` is called from the CodeMirror extension itself.
- **Task 7.** Line-number clicks hook into the existing `lineNumbers` gutter through its facet (handlers merge); there is no separate "+" column. The text typed in an open comment box is kept in the editor state, and a click on another line number does not replace a box that has text in it (`shouldReplaceDraft` in `model.ts`). Block widgets keep their spacing as padding on an outer element: CodeMirror does not measure margins of block widgets, which shifted every line below a comment box.
- **Task 3 and Task 4.** The attachment also says when a file was not open at send time (`uncheckedIds`), so its line numbers could not be checked.
- **Task 2.** The store caps the stored text (200 lines, 20,000 characters) so a select-all on a huge file cannot fill the browser's storage.
- **Task 8.** The send button is built (`send-button.tsx`). The composer-input route was measured and not built: it needs a new composer attachment kind and about five more upstream files (see the gate in Task 8).
- **Added after the plan:** comments in the rendered Markdown preview (`markdown-source-map.ts`, `preview-comments.web.tsx`, a native stand-in `preview-comments.tsx`, `float-position.ts`); the HTML preview only shows a pointer to Source. They are mounted by the same host, so they cost no upstream lines.
- **Footprint:** 56 upstream files and 506 lines (the plan allowed about 56 and 500). Lint's exhaustive-deps rule forced two extra lines in the two view files. The limit in `irix/scripts/upstream-footprint.mjs` and `IRIX.md` is now 56/510.

## Global Constraints

- The upstream footprint budget is raised to about 56 files and 500 lines (it is 52/488 now). Every upstream edit carries a `// Irix: reason` comment, is one to a few lines, renames nothing, moves no code and reformats nothing; if the formatter grows the change, undo it and find another way.
- Run `node irix/scripts/upstream-footprint.mjs` before and after touching an upstream file, and update the budget numbers and the upstream-files table in `IRIX.md`.
- Do not touch the protocol or the server. File comments only use a `{ type: "text", mimeType: "text/plain", title, text }` attachment.
- The attachment text starts with the fixed title `Paseo file comment attachment` (the diff's starts with `Paseo review attachment (...)`).
- Web only. Mobile (`view.native.tsx`) is not touched in this release. Browser and Electron use the same `.web.tsx` files; no Electron branch.
- Read `docs/design.md`, `docs/hover.md` and `docs/unistyles.md` before writing UI code. `useUnistyles()` is forbidden.
- Import `isWeb` from `@/constants/platform`; do not use `onPointerEnter`/`onPointerLeave`.
- Format and lint only through the npm scripts: `npm run format:files -- <path>`, `npm run lint -- <path>`; run `npm run typecheck` after changes.
- Run only the test files you changed: `npx vitest run <file> --bail=1`. Never the whole suite.
- Do not commit unless the user asks.
- The line and file counts in this plan are estimates from reading the code; the measured numbers from `upstream-footprint.mjs` win.

## Review Focus

1. A selection that ends at the start of the next line (column 0): the comment stops at the previous line and does not count the line that was not selected.
2. An empty selection and a whitespace-only selection: no "Comment" button and no comment.
3. CRLF files: the stored text has no `\r`, line numbers are unaffected.
4. A very long selection (hundreds of lines) or a very long line: the text in the attachment is cut and marked, the send does not fail.
5. A file with unsaved changes: the attachment says the line numbers refer to the editor content, and every comment carries its text.

---

## File structure

New (all in `packages/app/src/irix/file-comments/`):

| File                      | Responsibility                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model.ts`                | Comment type, add/update/delete/clear of the draft state, the draft key, selection to line range, text capping                                   |
| `store.ts`                | zustand + AsyncStorage persistence, hooks and non-hook read/write functions                                                                      |
| `format.ts`               | Lays the comments out as a `text` attachment                                                                                                     |
| `context.tsx`             | React context: the current file's `serverId`, `workspaceId`, `filePath`, `modified`; `IrixFileCommentsProvider`, `useIrixFileComments(filename)` |
| `editor-extension.web.ts` | CodeMirror extension: gutter click / drag / Shift+click, the selection button, markers for existing comments, the comment box                    |
| `send.ts`                 | Sending: `takeFileCommentsForSend` (for the diff's send) and the one-click send in the file view                                                 |
| `send-button.tsx`         | The "send to agent" entry in the file view                                                                                                       |
| matching `*.test.ts`      | Unit tests                                                                                                                                       |

Upstream files changed: `file-panels/source/panel.tsx`, `editor/view.web.tsx`, `readonly/view.web.tsx`, `review/feedback/use-feedback.ts`, and perhaps a few more from Task 8.

---

### Task 1: The comment model

**Files:**

- Create: `packages/app/src/irix/file-comments/model.ts`
- Test: `packages/app/src/irix/file-comments/model.test.ts`

**Interfaces:**

- Produces:
  - `interface FileComment { id: string; filePath: string; startLine: number; endLine: number; lineText: string; selectedText: string | null; body: string; createdAt: string; updatedAt: string }` (lines start at 1, `startLine <= endLine`, both times are ISO strings with an offset)
  - `type FileCommentState = { drafts: Record<string, FileComment[]> }`
  - `buildFileCommentKey(input: { serverId: string; workspaceId: string }): string`
  - `addComment(state, input: { key: string; comment: FileComment }): FileCommentState`
  - `updateComment(state, input: { key: string; id: string; body: string; updatedAt: string }): FileCommentState`
  - `deleteComment(state, input: { key: string; id: string }): FileCommentState`
  - `clearComments(state, input: { key: string; ids: readonly string[] }): FileCommentState` (clears only the given ids; deletes the key when it becomes empty)
  - `lineRangeFromSelection(doc: { lineAt(pos: number): { number: number; from: number } }, from: number, to: number): { startLine: number; endLine: number }`
  - `capText(text: string, limits: { maxLines: number; maxChars: number }): { text: string; truncated: boolean }`
  - `FileCommentStateSchema` (zod, written like `SerializedReviewDraftStateSchema` in `review/state.ts`, `z.strictObject`)
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests.** In `model.test.ts`, at least these cases:
  - `lineRangeFromSelection` with `from..to` inside one line gives `startLine === endLine`.
  - A selection that ends at the start of the next line (`to` equals some line's `from` and `to > from`) gives an `endLine` of the previous line (Review Focus 1).
  - A collapsed selection (`from === to`) gives one line.
  - `updateComment` on an id that does not exist returns the same state reference; `deleteComment` of the last comment removes the key; `clearComments` clears only the given ids.
  - `capText("a\nb\nc", { maxLines: 2, maxChars: 100 })` gives `{ text: "a\nb", truncated: true }`; `capText` also cuts past `maxChars` with `truncated: true` (Review Focus 4).
  - `FileCommentStateSchema.safeParse` fails for a comment without `lineText`.
- [ ] **Step 2: Run, confirm it fails:** `npx vitest run packages/app/src/irix/file-comments/model.test.ts --bail=1`; expected to fail because the module does not exist.
- [ ] **Step 3: Implement the interfaces above in `model.ts`.** The rule of `lineRangeFromSelection`: a collapsed selection takes its own line; otherwise, when `to` is exactly the `from` of its line, the end line is the line of `to - 1`.
- [ ] **Step 4: Run, confirm it passes,** with the same command.

---

### Task 2: The persisted store

**Files:**

- Create: `packages/app/src/irix/file-comments/store.ts`
- Test: `packages/app/src/irix/file-comments/store.test.ts`

**Interfaces:**

- Consumes: from Task 1 `FileComment`, `FileCommentState`, `FileCommentStateSchema`, `addComment`, `updateComment`, `deleteComment`, `clearComments`.
- Produces:
  - `useFileComments(key: string): FileComment[]` (the same empty array reference when there are no comments)
  - `addFileComment(input: { key: string; comment: Omit<FileComment, "id" | "createdAt" | "updatedAt"> }): FileComment`
  - `updateFileComment(input: { key: string; id: string; body: string }): void`
  - `deleteFileComment(input: { key: string; id: string }): void`
  - `getFileComments(key: string): FileComment[]`
  - `clearSentFileComments(input: { key: string; comments: readonly FileComment[] }): void`
  - `resetFileCommentStore(): void` (for tests)
  - AsyncStorage key `@irix:file-comment-store`

- [ ] **Step 1: Write the failing tests:** after `addFileComment`, `getFileComments` returns it and its id is not empty; `clearSentFileComments` clears only the given comments and keeps those added while the send was running; `resetFileCommentStore` empties the store. Mock AsyncStorage the way `packages/app/src/review/store.test.ts` does.
- [ ] **Step 2: Run, confirm it fails:** `npx vitest run packages/app/src/irix/file-comments/store.test.ts --bail=1`.
- [ ] **Step 3: Implement.** Follow `useReviewDraftStore` in `packages/app/src/review/store.ts` (`persist` + `createValidatedPersistStorage`), take the id from `generateMessageId()` and the times from `new Date().toISOString()`.
- [ ] **Step 4: Run, confirm it passes.**

---

### Task 3: Formatting the attachment

**Files:**

- Create: `packages/app/src/irix/file-comments/format.ts`
- Test: `packages/app/src/irix/file-comments/format.test.ts`

**Interfaces:**

- Consumes: from Task 1 `FileComment`, `capText`.
- Produces:
  - `formatFileCommentsAttachment(input: { comments: readonly FileComment[]; modifiedPaths: ReadonlySet<string>; driftedIds: ReadonlySet<string> }): Extract<AgentAttachment, { type: "text" }> | null` (returns `null` without comments). Import `AgentAttachment` from `@getpaseo/protocol/messages`.
  - The constant `FILE_COMMENT_ATTACHMENT_TITLE = "Paseo file comment attachment"`

The fixed shape of the text (a blank line between comments):

```
Paseo file comment attachment

Comment 1: src/a.ts:12-14
Selected text: <the selected words, selection comments only>
Commented lines:
> <first line of the text>
> <second line of the text>
<the comment>
```

- A one-line comment is written `src/a.ts:12`, several lines `src/a.ts:12-14`.
- For a comment whose file is in `modifiedPaths`, add the line `Note: the file has unsaved changes; line numbers refer to the editor content, not the file on disk.` above it.
- For a comment whose id is in `driftedIds`, add the line `Note: the file changed since this comment was written; the line numbers may be off, the commented text below is what the user saw.`
- The text of the lines and the selected text are cut with `capText` (`maxLines: 50`, `maxChars: 4000`, my decision); when cut, add a line `[truncated]` at the end.

- [ ] **Step 1: Write the failing tests:**
  - An empty list returns `null`.
  - A one-line comment, a multi-line comment and a comment with selected text each give text that equals the shape above, character for character.
  - A file with unsaved changes gets a Note line; a drifted comment gets a Note line; with neither, there is no Note line.
  - The text starts with `Paseo file comment attachment`; `title` equals `FILE_COMMENT_ATTACHMENT_TITLE`; `mimeType` is `text/plain`.
  - Very long text shows `[truncated]`.
- [ ] **Step 2: Run, confirm it fails:** `npx vitest run packages/app/src/irix/file-comments/format.test.ts --bail=1`.
- [ ] **Step 3: Implement** `formatFileCommentsAttachment`.
- [ ] **Step 4: Run, confirm it passes.**

---

### Task 4: Send logic (for the diff's send)

**Files:**

- Create: `packages/app/src/irix/file-comments/send.ts`
- Test: `packages/app/src/irix/file-comments/send.test.ts`

**Interfaces:**

- Consumes: from Task 2 `getFileComments`, `clearSentFileComments`; from Task 3 `formatFileCommentsAttachment`; from Task 1 `buildFileCommentKey`.
- Produces:
  - `registerOpenFile(input: { serverId: string; workspaceId: string; filePath: string; read: () => { lines: (start: number, end: number) => string | null; modified: boolean } }): () => void` (returns the function that unregisters; used by Task 6's context)
  - `takeFileCommentsForSend(input: { serverId: string; workspaceId: string }): { attachments: AgentAttachment[]; clearSent: () => void }` (with no comments, `attachments` is an empty array and `clearSent` does nothing)

Drift check: for each comment, if its file was registered through `registerOpenFile`, compare the current `lines(startLine, endLine)` with the stored `lineText`; when they differ the id goes into `driftedIds`. When the file is not open, there is no check (the attachment always carries the text, so the agent can compare itself). This is weaker than the spec's "check at send time"; the user needs to know. `modifiedPaths` comes from the `modified` flag of the registered files.

- [ ] **Step 1: Write the failing tests:**
  - No comments gives `attachments` equal to `[]`.
  - Comments on a file that is not open give one attachment and an empty `driftedIds`.
  - A registered file whose lines changed gives a drift Note in the attachment; unchanged gives none.
  - A registered file with `modified: true` gives the unsaved-changes Note.
  - After `clearSent()`, `getFileComments` holds only the comments added after the send.
- [ ] **Step 2: Run, confirm it fails:** `npx vitest run packages/app/src/irix/file-comments/send.test.ts --bail=1`.
- [ ] **Step 3: Implement.** The registry is a module-level `Map`, keyed by `${serverId}:${workspaceId}:${filePath}`.
- [ ] **Step 4: Run, confirm it passes.**

---

### Task 5: Sending together: change `use-feedback.ts`

**Files:**

- Modify: `packages/app/src/review/feedback/use-feedback.ts` (the `send:` callback, about lines 62-85)
- Test: no new file; the behavior is covered by Task 4's tests and Task 9's manual check.

**Interfaces:**

- Consumes: Task 4's `takeFileCommentsForSend`.

- [ ] **Step 1: Note the footprint before the change:** `node irix/scripts/upstream-footprint.mjs`.
- [ ] **Step 2: Change** the `send` callback: before `dispatchComposerAgentMessage`, `const fileComments = takeFileCommentsForSend({ serverId, workspaceId: workspaceId ?? "" });`; change `attachments: [attachment]` to `attachments: [attachment, ...fileComments.attachments]`; after a successful send (after `dispatchComposerAgentMessage`, before `toast.show`) call `fileComments.clearSent()`. Add one import. Every added line carries a `// Irix: file comments go with the diff comments` comment. Do not take file comments when `workspaceId` is empty.
- [ ] **Step 3: Run `npm run typecheck`;** expected to pass.
- [ ] **Step 4: Run the footprint script,** note the change in files and lines; it should be about 4 lines.

---

### Task 6: React context and the panel hook-in

**Files:**

- Create: `packages/app/src/irix/file-comments/context.tsx`
- Modify: `packages/app/src/file-panels/source/panel.tsx` (the return values of `ReadonlyTextFile` and `EditableTextFile`, about lines 134 and 228)
- Modify: `packages/app/src/file-panels/source/editor/view.web.tsx`
- Modify: `packages/app/src/file-panels/source/readonly/view.web.tsx`

**Interfaces:**

- Consumes: Task 4's `registerOpenFile`; Task 7's `irixFileCommentExtension` (execution order: do Task 7 first, then this task).
- Produces:
  - `IrixFileCommentsProvider(props: { serverId: string; workspaceId: string; filePath: string; modified: boolean; children: ReactNode })`
  - `useIrixFileComments(filename: string): Extension` (returns one stable CodeMirror extension; with no provider it returns the empty extension `[]`). It is used only from `.web` files, so `context.tsx` may import `@codemirror/*` only from `.web` files; if Metro would bundle `context.tsx` into the native build, move the CodeMirror part to `context.web.tsx` and put a native version that returns `[]` in `context.tsx`.

- [ ] **Step 1: Implement the provider and the hook.** The extension the hook returns calls Task 7's `irixFileCommentExtension(getContext)`; `getContext` reads the latest context through a ref, so the extension object stays the same for the life of the view and the editor is never rebuilt. The provider calls `registerOpenFile` in a `useEffect`; `read` returns the lines of the current CodeMirror document and `modified`.
- [ ] **Step 2: Change `panel.tsx`:** wrap the outermost `<View style={styles.container}>` returned by the two functions in `<IrixFileCommentsProvider ...>`, with `serverId` from `host.id`, `workspaceId`, `filePath: params.path`; `EditableTextFile` passes `modified={snapshot.modified}`, `ReadonlyTextFile` passes `modified={false}`. Each change gets a `// Irix:` comment. If the formatter reflows the wrapper into several lines, undo it and add an `IrixPanel` wrapper component at the top of the file instead.
- [ ] **Step 3: Change the two `view.web.tsx`:** at the top of the component `const irixComments = useIrixFileComments(filename);`, and put `irixComments,` in the `extensions` array after `find.extension`.
- [ ] **Step 4: `npm run typecheck`** passes.
- [ ] **Step 5: Run the footprint script,** note the change; it should be about 12 lines.

---

### Task 7: The CodeMirror extension

**Files:**

- Create: `packages/app/src/irix/file-comments/editor-extension.web.ts`
- Test: the environment is node and has no DOM, so the logic in this file that can be pulled out as pure functions (line ranges through Task 1's `lineRangeFromSelection`, the text of lines as a document slice) was tested in earlier tasks; the UI behavior is checked by hand in Task 9.

**Interfaces:**

- Consumes: from Task 1 `lineRangeFromSelection` and `buildFileCommentKey`; from Task 2 `useFileComments`, `addFileComment`, `updateFileComment`, `deleteFileComment`, `getFileComments`.
- Produces: `irixFileCommentExtension(getContext: () => { serverId: string; workspaceId: string; filePath: string } | null): Extension`

Behavior:

- Line-number gutter: hovering a line shows a `+` beside its number (use `gutter` and `GutterMarker`, hover in CSS, not `onPointerEnter`/`onPointerLeave`); a click selects that line and opens the box; pressing and dragging selects several lines; Shift+click makes the range from the last clicked line to this one.
- Selection: after selecting non-whitespace text, a "Comment" button floats by the end of the selection (`showTooltip` or `tooltips`); a click opens the box and records the first and last line and the selected text (`selectedText`). A collapsed or whitespace-only selection shows no button.
- Lines that have comments: a marker in the gutter (a `GutterMarker`, styled with theme colors, per `docs/design.md`); a click on the marker opens view / edit / delete for that comment.
- Box: a CodeMirror block widget (`Decoration.widget({ block: true })`) under the last line of the comment's range. It has a text area, Save and Cancel (and Delete when editing). On save, `lineText` is the document text inside the range (without `\r`). Mod+Enter submits, Esc cancels.
- Existing comments after the file changed: making markers follow with CodeMirror's `mapPos` is out of scope for this release; markers show at the stored line numbers, and comments past the end of the document show no marker.

- [ ] **Step 1: Implement the extension,** split into small functions by the behavior above (gutter, selection button, markers, box widget), all in this one file; when the file gets hard to read, split by responsibility into `editor-gutter.web.ts` and `editor-widget.web.ts` in the same directory.
- [ ] **Step 2: `npm run typecheck` and `npm run lint -- packages/app/src/irix/file-comments`** pass.

---

### Task 8: The one-click send in the file view, and the composer route (with a gate)

**Files:**

- Create: `packages/app/src/irix/file-comments/send-button.tsx`
- Modify: `packages/app/src/irix/file-comments/send.ts` (add `useFileCommentSend`)
- Modify: Task 6's `IrixFileCommentsProvider` (render this button)

**Interfaces:**

- Consumes: Task 4's `takeFileCommentsForSend`; `dispatchComposerAgentMessage` (`@/composer/actions`), `createMessageSubmissionWriter` (`@/composer/submission/writer`), `useWorkspaceLayoutStore` and `deriveWorkspaceTabModel` (the list of recipients; copy `readRecipients` from `use-feedback.ts`, do not import it, it is not exported), `useHostRuntimeClient`.
- Produces: `FileCommentSendButton(props: { serverId: string; workspaceId: string })`. When the workspace has file comments it shows "Send to agent (N)"; a click picks the recipient agent (with one agent it sends straight away); after a successful send it calls `clearSent()` and shows a notice; with no agent, or with the host disconnected, it is disabled and says why. Notice text goes through `i18n`, with keys in Irix's own resources and no change to the upstream language files. The prompt is one fixed sentence that tells the agent these are the user's comments on lines of files.

- [ ] **Step 1: Implement the button and `useFileCommentSend`;** the send flow follows `send` in `use-feedback.ts`.
- [ ] **Step 2: The gate for the composer route:** read `composer/attachments/workspace.tsx`, `attachments/types.ts`, `attachments/workspace-attachment-utils.ts`, `composer/attachments/workspace-cleanup.ts` and `stores/draft-store/migration.ts`, and list every upstream file that would change to make the composer know a "file comment" attachment, with a line estimate. **If adding it takes the total past about 56 files and 500 lines, stop and ask the user:** keep only the one-click send, or raise the budget again. Continue after the answer.
- [ ] **Step 3 (only if the budget allows or the user agrees): implement the composer route:** a new composer attachment kind `file_comment`, shown as a pill in the composer, sent with Task 3's formatted text, clearing the matching comments after the send.
- [ ] **Step 4: `npm run typecheck` and `npm run lint -- packages/app/src/irix/file-comments`** pass.

---

### Task 9: Footprint, docs, verification

**Files:**

- Modify: `IRIX.md` (the budget numbers; one row in the upstream-files table saying why these files are changed)
- Modify: `irix/scripts/upstream-footprint.mjs` (the default `--max-files` and `--max-lines`, if the script hard-codes them)

- [ ] **Step 1: Run the footprint script:** `node irix/scripts/upstream-footprint.mjs`; expected to pass, with no file missing an `Irix` marker.
- [ ] **Step 2: Update `IRIX.md`:** the budget numbers and the upstream-files table. Follow the "Writing docs" rules in `CLAUDE.md`: integrate into the existing paragraphs, do not append at the bottom.
- [ ] **Step 3: Run every new test file,** each one on its own, with `--bail=1`.
- [ ] **Step 4: `npm run typecheck`, `npm run lint`, `npm run format`** pass.
- [ ] **Step 5: Verify by hand in a browser** (`docs/qa.md` and the dev server in `docs/development.md`), with `npm run dev` and `npm run dev:app`; do not restart the main daemon on port 6767. When a real Claude test agent is needed, use Haiku with low thinking. Save a screenshot of each item to `out/` in the repo root (git-ignored):
  - Add a comment from a line number; drag over several lines; Shift+click for a range; select text and press the floating button.
  - When a word appears many times, the comment records the line of the selected one.
  - A selection that ends at the start of the next line makes the comment stop at the previous line.
  - An empty selection shows no button.
  - Edit and delete a comment; the comments and markers are still there after reopening the file.
  - Send while the file has unsaved changes: the attachment the agent gets has the Note and the text.
  - File comments and diff comments sent together: the agent can tell the two apart.
  - With only file comments, send with the button in the file view.
  - Comments work in the read-only view of a large file (over 1 MB).
- [ ] **Step 6: Report the results of the verification and the measured footprint numbers to the user,** and ask whether to commit.
