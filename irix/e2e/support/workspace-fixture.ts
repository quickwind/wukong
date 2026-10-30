import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Page } from "@playwright/test";
import { REPO_ROOT } from "./env";
import { baseUrl } from "./navigation";

export interface FixtureWorkspace {
  /** The git repository on disk (real path, no symlinks). */
  directory: string;
  workspaceId: string;
  /** Removes the workspace from the daemon and deletes the repository. */
  cleanup(): Promise<void>;
}

interface WorkspaceDescriptor {
  id: string;
}

interface DaemonClientLike {
  connect(): Promise<void>;
  close(): Promise<void>;
  addProject(cwd: string): Promise<{
    project: { projectId: string } | null;
    error: string | null;
  }>;
  removeProject(projectId: string): Promise<unknown>;
  createWorkspace(input: { source: { kind: "directory"; path: string } }): Promise<{
    workspace: WorkspaceDescriptor | null;
    error: string | null;
  }>;
}

async function connectClient(): Promise<DaemonClientLike> {
  // The daemon's address comes from the environment global-setup published, not from the state
  // file, which a second run in the same checkout would overwrite.
  const port = Number(new URL(baseUrl()).port);
  if (port === 6767 || port === 6890) throw new Error("refusing a real daemon port");
  // The client SDK is built to dist/ (build:server builds it); import it the way Node would,
  // because this file is compiled to CommonJS by Playwright.
  const clientUrl = pathToFileURL(path.join(REPO_ROOT, "packages/client/dist/daemon-client.js"));
  const { DaemonClient } = (await import(clientUrl.href)) as {
    DaemonClient: new (config: Record<string, unknown>) => DaemonClientLike;
  };
  const { WebSocket } = (await import("ws")) as { WebSocket: new (...args: unknown[]) => unknown };
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: `irix-e2e-${randomUUID()}`,
    clientType: "cli",
    appVersion: "0.0.0-irix-e2e",
    webSocketFactory: (url: string, options?: { headers?: Record<string, string> }) =>
      new WebSocket(url, { headers: options?.headers }),
  });
  await client.connect();
  return client;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Irix E2E",
      GIT_AUTHOR_EMAIL: "e2e@example.invalid",
      GIT_COMMITTER_NAME: "Irix E2E",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid",
    },
  });
}

/**
 * Creates a temp git repository with `files` (committed), registers it with the e2e daemon as a
 * project and returns its workspace. No provider or forge is involved.
 */
export async function createFixtureWorkspace(
  files: Record<string, string>,
  prefix = "irix-e2e-repo-",
): Promise<FixtureWorkspace> {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  git(directory, ["init", "-q", "-b", "main"]);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(directory, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-q", "-m", "fixture"]);

  const client = await connectClient();
  try {
    const added = await client.addProject(directory);
    if (!added.project) throw new Error(`addProject failed: ${added.error}`);
    const created = await client.createWorkspace({
      source: { kind: "directory", path: directory },
    });
    if (!created.workspace) throw new Error(`createWorkspace failed: ${created.error}`);
    const { projectId } = added.project;
    const workspaceId = created.workspace.id;
    return {
      directory,
      workspaceId,
      async cleanup() {
        const cleaner = await connectClient();
        try {
          await cleaner.removeProject(projectId);
        } catch {
          // The daemon may already be gone at teardown; the directory is removed regardless.
        } finally {
          await cleaner.close();
          rmSync(directory, { recursive: true, force: true });
        }
      },
    };
  } finally {
    await client.close();
  }
}

/**
 * Opens the workspace from the sidebar (the server id is not known up front, so the row is found
 * by the workspace id its test id ends with) and waits for its tab bar.
 */
export async function openWorkspace(page: Page, workspace: FixtureWorkspace): Promise<void> {
  await page.goto(baseUrl());
  const row = page.locator(`[data-testid$=":${workspace.workspaceId}"]`).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(
    page.getByTestId("workspace-tabs-row").filter({ visible: true }).first(),
  ).toBeVisible();
}

/** Reveals the explorer sidebar and selects its Files view. */
export async function openFilesPanel(page: Page): Promise<void> {
  const toggle = page.getByTestId("workspace-explorer-toggle").first();
  await expect(toggle).toBeVisible();
  const sidebar = page.getByTestId("workspace-explorer-sidebar").filter({ visible: true }).first();
  if ((await sidebar.count()) === 0) await toggle.click();
  await expect(sidebar).toBeVisible();
  const tab = sidebar.getByTestId("workspace-tab-files");
  if ((await tab.getAttribute("aria-selected")) !== "true") {
    await tab.click({ position: { x: 12, y: 13 } });
  }
  await expect(
    page.getByTestId("file-explorer-tree-scroll").filter({ visible: true }),
  ).toBeVisible();
}

/** Opens a file of the root folder from the Files tree. */
export async function openFileFromTree(page: Page, fileName: string): Promise<void> {
  await page
    .getByTestId("file-explorer-tree-scroll")
    .filter({ visible: true })
    .getByText(fileName, { exact: true })
    .first()
    .click();
}
