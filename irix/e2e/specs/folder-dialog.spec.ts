// changes-from-upstream.md: item 21 (in-app folder dialog: Open folder browses the disk through
// the daemon; the dialog is drawn inside Add project's own modal so focus trapping cannot freeze
// the page).
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  goToFolder,
  makeTempDir,
  openFolderDialog,
  sidebarProject,
} from "../support/new-workspace-helpers";

test("Open folder browses, creates a folder and adds the chosen one as a project", async ({
  page,
}) => {
  const parent = makeTempDir("irix-e2e-folders-");
  const suffix = path.basename(parent).slice(-6);
  const chosen = `beta-${suffix}`;
  mkdirSync(path.join(parent, "alpha-dir"));
  mkdirSync(path.join(parent, chosen));
  writeFileSync(path.join(parent, "notes-file.txt"), "not a folder\n");

  await openFolderDialog(page);
  const dialog = page.getByTestId("irix-folder-picker");

  // The page must stay responsive: the dialog takes typing and clicks right after opening.
  await goToFolder(page, parent);
  await expect(dialog.getByRole("button", { name: "alpha-dir" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: chosen })).toBeVisible();
  await expect(dialog.getByText("notes-file.txt")).toHaveCount(0);

  // The search box narrows the list.
  await dialog.getByLabel("Search folders").fill("alpha");
  await expect(dialog.getByRole("button", { name: chosen })).toHaveCount(0);
  await dialog.getByLabel("Search folders").fill("");
  await expect(dialog.getByRole("button", { name: chosen })).toBeVisible();

  // New folder: created on disk, and the dialog opens it.
  await dialog.getByRole("button", { name: "New folder" }).click();
  await dialog.getByLabel("New folder name").fill("created-in-dialog");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const created = path.join(parent, "created-in-dialog");
  await expect(dialog.getByText(created, { exact: true }).first()).toBeVisible();
  expect(existsSync(created) && statSync(created).isDirectory()).toBe(true);

  // Up to the parent: the new folder is listed next to the others.
  await dialog.getByRole("button", { name: ".. (Up to parent)" }).click();
  await expect(dialog.getByRole("button", { name: "created-in-dialog" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "alpha-dir" })).toBeVisible();

  // Navigate into a subfolder by clicking, then choose it.
  await dialog.getByRole("button", { name: chosen }).click();
  await expect(dialog.getByText(path.join(parent, chosen), { exact: true }).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Choose Folder" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("add-project-flow")).toHaveCount(0);
  // The project is added: its row is in the sidebar.
  await expect(sidebarProject(page, chosen)).toBeVisible();
});

test("Cancel and Escape close the folder dialog without adding a project", async ({ page }) => {
  await openFolderDialog(page);
  const dialog = page.getByTestId("irix-folder-picker");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  // Add project is still usable underneath (no frozen focus trap).
  await expect(page.getByTestId("add-project-flow")).toBeVisible();
  await page.getByTestId("add-project-flow-method-browse").click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
