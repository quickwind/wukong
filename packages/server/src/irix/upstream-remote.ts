// Irix: a fork checkout has two remotes, `origin` (the user's fork) and `upstream` (the project the
// work goes to). Paseo only fetches and lists `origin`; these two helpers add `upstream`, so its
// branches stay current and can be picked as the source of a new worktree.

import { runGitCommand, type RunGitCommand } from "../utils/run-git-command.js";
import { isIrixActive } from "./policy.js";

const UPSTREAM_REF_PREFIX = "refs/remotes/upstream/";

export interface UpstreamBranchDetail {
  name: string;
  committerDate: number;
  hasRemote: true;
  remote: "upstream";
}

async function hasUpstreamRemote(cwd: string, run: RunGitCommand): Promise<boolean> {
  try {
    const { stdout } = await run(["config", "--get", "remote.upstream.url"], { cwd });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Fetches `upstream` next to `origin`. A failure here (no access, offline) must not hide what the
 * `origin` fetch did, so it is swallowed.
 */
export async function fetchUpstreamRemote(
  cwd: string,
  run: RunGitCommand = runGitCommand,
): Promise<void> {
  if (!isIrixActive() || !(await hasUpstreamRemote(cwd, run))) {
    return;
  }
  try {
    await run(["fetch", "upstream", "--prune"], {
      cwd,
      envOverlay: { GIT_TERMINAL_PROMPT: "0" },
      timeout: 120_000,
    });
  } catch {
    // Left for the next round.
  }
}

export interface UpstreamBranchOptions {
  query?: string;
  limit?: number;
}

/** The branches of the `upstream` remote that are already fetched, newest first. */
export async function listUpstreamBranchDetails(
  cwd: string,
  options: UpstreamBranchOptions = {},
  run: RunGitCommand = runGitCommand,
): Promise<UpstreamBranchDetail[]> {
  if (!isIrixActive()) {
    return [];
  }
  const { stdout } = await run(
    [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)%09%(committerdate:unix)",
      UPSTREAM_REF_PREFIX,
    ],
    { cwd },
  );
  const query = options.query?.trim().toLowerCase() ?? "";
  const details: UpstreamBranchDetail[] = [];
  for (const line of stdout.split("\n")) {
    const [ref, date] = line.trim().split("\t");
    if (!ref?.startsWith(UPSTREAM_REF_PREFIX)) continue;
    const name = ref.slice(UPSTREAM_REF_PREFIX.length);
    if (!name || name === "HEAD" || (query && !name.toLowerCase().includes(query))) continue;
    details.push({ name, committerDate: Number(date) || 0, hasRemote: true, remote: "upstream" });
  }
  return options.limit === undefined ? details : details.slice(0, options.limit);
}
