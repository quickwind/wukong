// changes-from-upstream.md: 19 (comments on lines of a file, CodeMirror source view, web).
import { expect, test } from "@playwright/test";
import {
  createFixtureWorkspace,
  openFileFromTree,
  openFilesPanel,
  openWorkspace,
  type FixtureWorkspace,
} from "../support/workspace-fixture";

let workspace: FixtureWorkspace;

test.beforeAll(async () => {
  workspace = await createFixtureWorkspace({
    "notes.txt": ["alpha line", "bravo line", "charlie line", "delta line", "echo line", ""].join(
      "\n",
    ),
  });
});

test.afterAll(async () => {
  await workspace?.cleanup();
});

test("a click on a line number comments on that line, Shift+click on a range", async ({ page }) => {
  await openWorkspace(page, workspace);
  await openFilesPanel(page);
  await openFileFromTree(page, "notes.txt");

  const editor = page.locator(".cm-editor").filter({ visible: true }).first();
  await expect(editor).toBeVisible();
  await expect(editor.locator(".cm-content")).toContainText("charlie line");
  const gutterLine = (line: number) =>
    editor.locator(".cm-lineNumbers .cm-gutterElement", { hasText: new RegExp(`^${line}$`) });

  // One line.
  await gutterLine(2).click();
  const draft = editor.locator(".irix-comment-draft");
  await expect(draft).toBeVisible();
  await expect(draft.locator(".irix-comment-meta")).toHaveText("Line 2");
  await draft.locator("textarea").fill("rename bravo");
  await draft.getByRole("button", { name: "Save" }).click();

  const saved = editor.locator(".irix-comment-box:not(.irix-comment-draft)");
  await expect(saved).toHaveCount(1);
  await expect(saved.locator(".irix-comment-meta")).toHaveText("Line 2");
  await expect(saved.locator(".irix-comment-body")).toHaveText("rename bravo");
  await expect(editor.locator(".irix-comment-dot").first()).toBeAttached();

  // The file view offers its own send button once a comment exists.
  const send = page.getByTestId("irix-file-comments-send");
  await expect(send).toBeVisible();
  await expect(send).toHaveAttribute("aria-label", /^Send 1 comment/);

  // A range: click line 3, Shift+click line 5.
  await gutterLine(3).click();
  await gutterLine(5).click({ modifiers: ["Shift"] });
  await expect(draft.locator(".irix-comment-meta")).toHaveText("Lines 3-5");
  await draft.locator("textarea").fill("tighten this block");
  await draft.getByRole("button", { name: "Save" }).click();

  await expect(saved).toHaveCount(2);
  await expect(saved.filter({ hasText: "Lines 3-5" }).locator(".irix-comment-body")).toHaveText(
    "tighten this block",
  );
  await expect(send).toHaveAttribute("aria-label", /^Send 2 comments/);
});

test("a saved comment can be deleted and the send button goes away", async ({ page }) => {
  await openWorkspace(page, workspace);
  await openFilesPanel(page);
  await openFileFromTree(page, "notes.txt");
  const editor = page.locator(".cm-editor").filter({ visible: true }).first();
  await expect(editor.locator(".cm-content")).toContainText("delta line");

  // Comments of the previous test live in the browser's store only for that page; a new page has
  // none, so this one starts clean.
  await expect(page.getByTestId("irix-file-comments-send")).toHaveCount(0);
  await editor.locator(".cm-lineNumbers .cm-gutterElement", { hasText: /^4$/ }).click();
  await editor.locator(".irix-comment-draft textarea").fill("temporary");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("irix-file-comments-send")).toBeVisible();

  await editor.getByRole("button", { name: "Delete" }).click();
  await expect(editor.locator(".irix-comment-body")).toHaveCount(0);
  await expect(page.getByTestId("irix-file-comments-send")).toHaveCount(0);
});
