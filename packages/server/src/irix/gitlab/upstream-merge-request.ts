// Irix: with a fork workflow (Fork clone adds an `upstream` remote) "Create merge request" should
// propose the current branch to the upstream project, and GitLab's own page is the place to review
// and fill in a cross-project request. So when the checkout has an `upstream` remote on the
// configured GitLab, the button opens GitLab's "new merge request" page in the default browser,
// from the current branch of `origin` to the default branch of `upstream`, with the title and
// description the daemon drafted. Nothing is created until the person presses Create there.
// Without an `upstream` remote the request is created over the API as before.

import { spawn } from "node:child_process";
import { runGitCommand } from "../../utils/run-git-command.js";
import type { GitLabClient } from "./client.js";
import { parseGitLabProjectPath, type GitLabForgeConfig } from "./config.js";

/** Longest URL we hand to a browser and to GitLab's front proxy (commonly capped near 8 KB). */
const MAX_URL_LENGTH = 6000;

/** Thrown after the page was opened: the request exists only once the person submits it there. */
export class MergeRequestPageOpenedError extends Error {
  constructor(
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "MergeRequestPageOpenedError";
  }
}

export interface NewMergeRequestPage {
  /** Web address of the GitLab instance, no trailing slash. */
  baseUrl: string;
  targetPath: string;
  sourceProjectId: number;
  targetProjectId: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

function pageUrl(page: NewMergeRequestPage, description: string): string {
  const query = new URLSearchParams({
    "merge_request[source_project_id]": String(page.sourceProjectId),
    "merge_request[source_branch]": page.sourceBranch,
    "merge_request[target_project_id]": String(page.targetProjectId),
    "merge_request[target_branch]": page.targetBranch,
    "merge_request[title]": page.title,
  });
  if (description) query.set("merge_request[description]", description);
  const path = page.targetPath.split("/").map(encodeURIComponent).join("/");
  return `${page.baseUrl}/${path}/-/merge_requests/new?${query.toString()}`;
}

/** The "new merge request" page URL; a long description is cut so the address stays usable. */
export function buildNewMergeRequestUrl(page: NewMergeRequestPage): string {
  let description = page.description;
  let url = pageUrl(page, description);
  while (url.length > MAX_URL_LENGTH && description.length > 0) {
    description = description.slice(0, Math.floor(description.length * 0.8)).trimEnd();
    url = pageUrl(page, description);
  }
  return url;
}

export type LaunchBrowser = (url: string) => Promise<void>;

function browserCommand(url: string): [string, string[]] {
  if (process.platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (process.platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

/** Opens `url` in the default browser of the machine the daemon runs on (no shell is involved). */
export const openInDefaultBrowser: LaunchBrowser = (url) =>
  new Promise((resolve, reject) => {
    const [command, args] = browserCommand(url);
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

async function remoteUrl(cwd: string, remote: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["config", "--get", `remote.${remote}.url`], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface UpstreamMergeRequestDeps {
  config: GitLabForgeConfig;
  client: GitLabClient;
  /** Test seam: the URL of a remote, or null when there is none. */
  resolveRemoteUrl?: (cwd: string, remote: string) => Promise<string | null>;
  launch?: LaunchBrowser;
}

export interface UpstreamMergeRequestInput {
  cwd: string;
  head: string;
  title: string;
  body?: string;
}

/**
 * Opens the new-merge-request page when `cwd` has an `upstream` remote on the configured GitLab
 * that is a different project from `origin`, and throws {@link MergeRequestPageOpenedError} to say
 * so. Returns false when the checkout has no such remote, and the caller creates the request itself.
 */
export async function openUpstreamMergeRequestPage(
  deps: UpstreamMergeRequestDeps,
  input: UpstreamMergeRequestInput,
): Promise<false> {
  const { config, client } = deps;
  const readRemote = deps.resolveRemoteUrl ?? remoteUrl;
  const [originUrl, upstreamUrl] = await Promise.all([
    readRemote(input.cwd, "origin"),
    readRemote(input.cwd, "upstream"),
  ]);
  const originPath = originUrl ? parseGitLabProjectPath(config, originUrl) : null;
  const upstreamPath = upstreamUrl ? parseGitLabProjectPath(config, upstreamUrl) : null;
  if (!originPath || !upstreamPath || originPath === upstreamPath) {
    return false;
  }

  const [source, target] = await Promise.all([
    client.getProject({ cwd: input.cwd, project: originPath }),
    client.getProject({ cwd: input.cwd, project: upstreamPath }),
  ]);
  const targetBranch = target.default_branch;
  if (!targetBranch) {
    throw new Error(`${upstreamPath} has no default branch to propose the change to`);
  }
  const url = buildNewMergeRequestUrl({
    baseUrl: config.url.replace(/\/+$/u, ""),
    targetPath: target.path_with_namespace,
    sourceProjectId: source.id,
    targetProjectId: target.id,
    sourceBranch: input.head,
    targetBranch,
    title: input.title,
    description: input.body ?? "",
  });

  const summary = `${originPath}:${input.head} → ${upstreamPath}:${targetBranch}`;
  try {
    await (deps.launch ?? openInDefaultBrowser)(url);
  } catch (error) {
    throw new MergeRequestPageOpenedError(
      url,
      `Could not open the browser (${(error as Error).message}). Open this link to create the merge request ${summary}: ${url}`,
    );
  }
  throw new MergeRequestPageOpenedError(
    url,
    `Opened the new merge request page in your browser (${summary}). The merge request is created when you submit it there.`,
  );
}
