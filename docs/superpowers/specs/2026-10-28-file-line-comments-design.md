# Comments on lines of a file

Date: 2026-10-28. Status: implemented (web only), not committed.

## Purpose

When the user reads code in the file view, they want to leave a comment on some lines and hand it to an agent later. The diff view already has this flow (a "+" at the line number, comment drafts, one-click send to an agent). The file view does not. Upstream has an issue for it (#499, closed); upstream only built the diff flow, not the file view. Irix adds it.

## Goals

- Comment on one line or several lines in the file view, two ways in:
  - Click a line number (drag, or Shift+click, for several lines).
  - Select some text, then press the button that appears.
- Every comment carries its line numbers (first and last line). A comment made from a text selection also carries the selected text. A word that appears many times is never pointed at the wrong place.
- Comments go to an agent together with diff comments. The agent can tell from the message which comments came from a file and which came from the diff.
- The first release is web only. Browser and Electron use the same `.web.tsx` files, so there is no separate Electron branch; QA in a browser is enough (my decision).

## Non-goals

- Mobile (the React Native `FlatList` file view). Later; do not close the door on it in the design.
- Comments in the HTML preview or on images. The HTML preview is a sandboxed frame the page cannot read, and an image has no lines. The HTML preview shows a pointer to the Source view instead.
- Comment threads, replies, resolved state.
- Any change to the server or the protocol.

Added after the first release: the rendered Markdown preview is in scope. See "Markdown preview" below.

## Anti-goals

- Changing more upstream files than needed. Keeping the footprint small is this fork's first rule (`IRIX.md`).
- Sending a comment to the wrong place after the line numbers moved, without saying so.

## Constraints

- Upstream footprint budget: it was 52 files and 488 lines (limit 52/490). The user agreed to raise it for this feature to about 56 files and 500 lines, no more. Run `node irix/scripts/upstream-footprint.mjs` before and after, and update the budget numbers and the upstream-files table in `IRIX.md`. The result was 56 files and 506 lines; the limit is now 56/510 (the user was told).
- Every upstream edit carries a `// Irix: reason` comment, is one to a few lines, renames nothing and moves no code.
- Do not touch the protocol or the server. File comments go as the existing `text` attachment (`type: "text"` in `packages/protocol/src/messages.ts`), laid out as text by the client.
- Read `docs/design.md`, `docs/coding-standards.md`, `docs/hover.md` and `docs/unistyles.md` before writing UI code.

## Decisions (the user's)

- File comments and diff comments are sent together, not as a separate flow.
- Comments carry line numbers; a text selection carries the lines and the text.
- Touch as few upstream files as possible; new code goes in new files under `packages/app/src/irix/`.
- Web first; the budget is raised to about 56 files and 500 lines.
- Markdown preview: comment directly in the preview (a floating box and a list at the bottom of the preview), not by jumping to Source. HTML preview: no comments, a pointer to Source.
- A file with unsaved changes is sent as it is, with a note; the send is not blocked and does not ask for a save first.

## Outline of the design (mine; the user did not confirm each part)

**Hook-in points.** Only at the rendering layer; the logic lives in new Irix files:

| Upstream file                              | Change                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file-panels/builtin.tsx`                  | The built-in file panels render inside an Irix host that carries the file and workspace the comments belong to, the send button and the preview comments. (The first plan wrapped `file-panels/source/panel.tsx`; one wrapper in `BuiltinFilePanelView` is a single choke point and needs fewer lines.) |
| `file-panels/source/editor/view.web.tsx`   | One Irix extension in the CodeMirror extension list (editable files, up to 1 MB).                                                                                                                                                                                                                       |
| `file-panels/source/readonly/view.web.tsx` | The same (read-only, large files).                                                                                                                                                                                                                                                                      |
| `review/feedback/use-feedback.ts`          | When a diff comment is sent, the workspace's file comments go along as one `text` attachment, and are cleared after a successful send.                                                                                                                                                                  |

**Irix extension (new files).** CodeMirror line-number clicks and drags and a selection listener give the two ways in. Lines that have comments show a marker in the gutter. The comment box is a CodeMirror block widget under the last line of the comment's range, with Edit and Delete on saved comments; it does not mount React DOM inside the editor. The line-number clicks hook into the existing `lineNumbers` gutter through its facet, which merges handlers, so no upstream line configures it.

**Draft store (new file).** Separate from the diff's review draft store; `review/store.ts` is not changed. Keyed by server and workspace, persisted the way review drafts are (zustand and AsyncStorage). Each comment holds the file path, the first and last line, the text of those lines when the comment was written (stored for every comment, including those made from a line number), the selected text (selection comments only), the comment text, and created and updated times. The lines' text is kept so a send can check whether the line numbers moved. Stored text is capped (200 lines, 20,000 characters) so a select-all on a huge file cannot fill the browser's storage.

**When and where a send goes.** The send in `use-feedback.ts` sends the prompt plus attachments straight to the agent the user picked (`dispatchComposerAgentMessage`); it does not add to the composer draft. Diff comments are kept per workspace, and so are file comments, so one send carries both for the same workspace. After a successful send the sent file comments are cleared; on failure they stay, as with diff comments (`clearSent`).

`dispatchComposerAgentMessage` takes composer attachments. A `chat_history` composer attachment hands its text attachment to the wire untouched, so the file comments travel as that kind. No new attachment kind is needed.

The diff's `review` attachment also has a second route: it is a "workspace attachment" in the composer (`composer/attachments/workspace.tsx`), shown as a pill and sent with the text the user types. File comments should take both routes, but the second needs the composer to know a new attachment kind (`attachments/types.ts`, `workspace-attachment-utils.ts`, the draft store migration and more) and was measured at about five more upstream files and 20 or more lines. It is not built; it needs a decision on the budget (see Open items).

**What is sent.** One `text` attachment that starts with a fixed title, `Paseo file comment attachment`; the diff's `review` attachment starts with `Paseo review attachment (...)`, so the two are told apart at a glance. Each comment lists `path:first-last line`, the selected text if any, the text of the commented lines, and the comment. Notes are added where they apply: unsaved changes in the editor, the file changed since the comment was written, the file was not open to check against. When only file comments exist, there is a send button in the file view (see "Left to the implementer", item 1).

## Markdown preview

The Markdown preview is rendered HTML with no line markers, so the lines of a selection are found by matching the selected text against the source's text (`markdown-source-map.ts`).

- Only letters and digits are compared, so markup, list bullets and whitespace differences do not matter.
- The source is parsed to a syntax tree with positions; text, inline code and code blocks give the text and its line. Front matter lines are counted. A fenced code block's text starts on the line after the fence.
- When a selected passage appears more than once, the surrounding text (about 40 characters on each side) picks the occurrence. If two occurrences score the same, the result is "ambiguous"; if the text is not in the source (front matter table, HTML blocks), "not found". Both are shown to the user as messages; no line number is guessed.
- When the whole selection does not match because the page shows characters the source text lacks (for example list markers in the middle), the first and last 40 characters are matched separately.
- Mounted by the same Irix host as the send button, so it needs no upstream lines. Web only.
- The selection button and the draft box float by the selection and are kept inside the window (`float-position.ts`); the saved comments are listed in a scrollable box at the bottom right, above the send button.
- The HTML preview runs in a sandboxed frame; the page only shows "To comment on this file, switch to Source."

## Left to the implementer

1. How to send when there are no diff comments. The existing send button (`ReviewFeedbackButton`) only appears in the diff view. Candidate: a similar "send to agent" button in the Irix host, following the agent choice and the send in `review/feedback/`. This was built (`send-button.tsx`).
2. Moved line numbers. After an agent or a local edit changes the file, the recorded line numbers may no longer match the text. At send time, compare the recorded lines with the stored text of the lines (every comment has it); when they differ, say in the attachment "the file changed since this comment was written; the line numbers may be off, the commented text is what the user saw", and still send. Line numbers mean what the screen showed when the comment was written. If the file has unsaved edits at send time, send as usual (the user confirmed: no blocking, no save prompt) with the note "the file has unsaved changes; line numbers refer to the editor content, not the file on disk", and put the text of the commented lines in every comment, because the agent reads the disk and cannot see unsaved content. Whether comments follow their lines while an editable file is being edited (CodeMirror position mapping) is the implementer's call; skip it if it goes over budget. Built: the check runs for files that are open in an editor; for a file that is not open the attachment says the line numbers were not checked, and still carries the text.
   2a. Budget fallback (my decision): if the `use-feedback.ts` change does not fit in a few lines, let the Irix host own the send, keep the "send together" requirement, and see whether the total still fits in about 56 files and 500 lines. If it does not, stop and ask the user instead of going over the budget quietly.
3. Limits on the number of comments and the length of one comment, and the marker style in the gutter, follow `docs/design.md`.
4. Tests go in the existing suites (`docs/testing.md`); the attachment text format and the draft store rules need unit tests.
5. Mobile comes in a later release. Do not make the store and the attachment format web-only.
