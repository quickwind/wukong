// changes-from-upstream.md: item 20 (Name + Create bar: a new workspace or chat tab is named and
// created first; the chat comes after).
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  addProjectThroughDialog,
  initGitRepo,
  makeTempDir,
  sidebarProject,
} from "../support/new-workspace-helpers";

test("Create workspace makes a named workspace without a message, then Create chat names a chat tab", async ({
  page,
}) => {
  const root = makeTempDir("irix-e2e-namebar-");
  const repo = path.join(root, `proj-${path.basename(root).slice(-6)}`);
  initGitRepo(repo);
  const projectName = path.basename(repo);
  const workspaceName = `ws-${path.basename(root).slice(-6)}`;
  const chatName = `chat-${path.basename(root).slice(-6)}`;

  await addProjectThroughDialog(page, repo);
  await expect(sidebarProject(page, projectName)).toBeVisible();

  // New workspace screen: the bar is there, above the composer.
  const nameInput = page.getByTestId("irix-name-workspace");
  const create = page.getByTestId("irix-create-workspace");
  await expect(page.getByText("New workspace", { exact: true }).first()).toBeVisible();
  await expect(nameInput).toBeVisible();
  await expect(create).toBeVisible();
  await expect(create).toHaveText("Create workspace");

  await nameInput.fill(workspaceName);
  await create.click();

  // A workspace with that name exists, in the sidebar and as the open screen, with no message sent.
  await expect(page).toHaveURL(/\/workspace\//);
  await expect(
    page.locator('[data-testid^="sidebar-workspace-row-"]').filter({ hasText: workspaceName }),
  ).toBeVisible();
  await expect(page.getByTestId("irix-name-workspace")).toHaveCount(0);
  // The workspace holds no chat yet: only the empty "New tab" launcher.
  await expect(page.getByRole("button", { name: "New tab" }).first()).toBeVisible();

  // Open a draft chat tab from the launcher.
  await page.getByText("Agent", { exact: true }).first().click();
  const chatInput = page.getByLabel("Chat name");
  const createChat = page.getByRole("button", { name: "Create chat" });
  await expect(chatInput).toBeVisible();
  await expect(createChat).toBeVisible();

  // An empty name is refused with a hint, and nothing is renamed.
  await createChat.click();
  await expect(page.getByText("Give the chat a name")).toBeVisible();

  await chatInput.fill(chatName);
  await expect(page.getByText("Give the chat a name")).toHaveCount(0);
  await createChat.click();

  // The tab is titled with the name and the bar is gone; no first message was sent.
  await expect(page.getByRole("button", { name: "Create chat" })).toHaveCount(0);
  await expect(page.getByLabel("Chat name")).toHaveCount(0);
  await expect(
    page
      .locator('[data-testid^="workspace-tab-"]:not([data-testid^="workspace-tab-tooltip-"])')
      .filter({ hasText: chatName }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: /message/i }).first()).toBeVisible();
  await expect(page.getByTestId("user-message")).toHaveCount(0);
});
