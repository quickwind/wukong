import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { baseUrl } from "./navigation";

/** A fresh temp directory under the real (symlink-resolved) temp root, so paths compare equal. */
export function makeTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** `git init` with one commit, so Paseo treats the folder as a real repository. */
export function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Irix e2e",
        GIT_AUTHOR_EMAIL: "e2e@example.invalid",
        GIT_COMMITTER_NAME: "Irix e2e",
        GIT_COMMITTER_EMAIL: "e2e@example.invalid",
      },
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

/** Opens Add project -> Open folder and waits for the in-app folder dialog. */
export async function openFolderDialog(page: Page): Promise<void> {
  await page.goto(baseUrl());
  await page.getByTestId("sidebar-add-project").click();
  await expect(page.getByTestId("add-project-flow")).toBeVisible();
  await page.getByTestId("add-project-flow-method-browse").click();
  await expect(page.getByTestId("irix-folder-picker")).toBeVisible();
}

/** Types a path into the dialog's path box and presses Enter; waits until it is listed. */
export async function goToFolder(page: Page, dir: string): Promise<void> {
  const dialog = page.getByTestId("irix-folder-picker");
  const input = dialog.getByLabel("Folder path");
  await input.fill(dir);
  await input.press("Enter");
  await expect(dialog.getByText(dir, { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("Loading folders...")).toHaveCount(0);
}

/**
 * Adds `dir` as a project through Add project -> Open folder, as a user would. Afterwards the app
 * is on the New workspace screen of that project.
 */
export async function addProjectThroughDialog(page: Page, dir: string): Promise<void> {
  await openFolderDialog(page);
  await goToFolder(page, dir);
  await page
    .getByTestId("irix-folder-picker")
    .getByRole("button", { name: "Choose Folder" })
    .click();
  await expect(page.getByTestId("irix-folder-picker")).toHaveCount(0);
  await expect(page.getByTestId("add-project-flow")).toHaveCount(0);
}

/** The sidebar's project rows whose name is `name`. Zero rows when the project is not listed. */
export function sidebarProject(page: Page, name: string): Locator {
  return page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ has: page.getByText(name, { exact: true }) });
}
