// changes-from-upstream.md: item 23 (a plugin-managed project, Bot Crew's Bots, is left out of the
// sidebar and the New workspace project list; the daemon still knows it).
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  addProjectThroughDialog,
  initGitRepo,
  makeTempDir,
  sidebarProject,
} from "../support/new-workspace-helpers";
import { baseUrl } from "../support/navigation";

test("a Bot Crew project is hidden from the sidebar and New workspace, an ordinary one is not", async ({
  page,
}) => {
  const root = makeTempDir("irix-e2e-managed-");
  const suffix = path.basename(root).slice(-6);
  const ordinary = path.join(root, `ordinary-${suffix}`);
  const managed = path.join(root, "plugin-data", "bot-crew", "shared", `Bots-${suffix}`);
  initGitRepo(ordinary);
  initGitRepo(managed);

  await addProjectThroughDialog(page, ordinary);
  await expect(sidebarProject(page, `ordinary-${suffix}`)).toBeVisible();

  // The daemon accepts the managed project (the dialog's Choose Folder succeeds and it lands on
  // the New workspace screen), but the app does not list it.
  await addProjectThroughDialog(page, managed);
  await page.goto(baseUrl());
  await expect(sidebarProject(page, `ordinary-${suffix}`)).toBeVisible();
  await expect(sidebarProject(page, `Bots-${suffix}`)).toHaveCount(0);
  await expect(page.getByText(`Bots-${suffix}`)).toHaveCount(0);

  // New workspace: the project picker offers the ordinary project and not the managed one.
  await page.getByTestId("sidebar-global-new-workspace").click();
  const picker = page.getByTestId("new-workspace-project-picker-trigger");
  await expect(picker).toBeVisible();
  await picker.click();
  await expect(page.getByText(`ordinary-${suffix}`, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(`Bots-${suffix}`)).toHaveCount(0);
});
