// Irix: which GitLab project holds a checkout's merge requests. Fork clone leaves two remotes:
// `origin` (the user's fork) and `upstream` (the project the work is proposed to). GitLab keeps a
// merge request in its target project, so for such a checkout the requests are in `upstream`, and
// the ones that are this checkout's are those whose source is the fork.
//
// The remotes are read through the cache in upstream-cache.ts, so asking again costs no process.

import { runGitCommand } from "../../utils/run-git-command.js";
import { parseGitLabProjectPath, type GitLabForgeConfig } from "./config.js";
import {
  defaultUpstreamCaches,
  gitConfigFingerprint,
  type RemoteUrls,
  type UpstreamCaches,
} from "./upstream-cache.js";

export type RemoteName = "origin" | "upstream";
export type RemoteReader = (cwd: string, remote: RemoteName) => Promise<string | null>;

export const gitRemoteReader: RemoteReader = async (cwd, remote) => {
  try {
    const { stdout } = await runGitCommand(["config", "--get", `remote.${remote}.url`], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

export interface ReadRemoteUrlsOptions {
  cwd: string;
  read?: RemoteReader;
  /** What tells the cached remotes are out of date (null: never cache). */
  fingerprint?: (cwd: string) => Promise<string | null>;
  caches?: UpstreamCaches;
}

export async function readRemoteUrls(options: ReadRemoteUrlsOptions): Promise<RemoteUrls> {
  const { cwd, read = gitRemoteReader } = options;
  const caches = options.caches ?? defaultUpstreamCaches;
  return caches.remotes.get(
    cwd,
    await (options.fingerprint ?? gitConfigFingerprint)(cwd),
    async (): Promise<RemoteUrls> => {
      const [origin, upstream] = await Promise.all([read(cwd, "origin"), read(cwd, "upstream")]);
      return { origin, upstream };
    },
  );
}

export interface ForkPair {
  originPath: string;
  upstreamPath: string;
}

/** The two project paths when the checkout is a fork of another project on the configured GitLab. */
export function forkPairOf(config: GitLabForgeConfig, remotes: RemoteUrls): ForkPair | null {
  const originPath = remotes.origin ? parseGitLabProjectPath(config, remotes.origin) : null;
  const upstreamPath = remotes.upstream ? parseGitLabProjectPath(config, remotes.upstream) : null;
  if (!originPath || !upstreamPath || originPath === upstreamPath) {
    return null;
  }
  return { originPath, upstreamPath };
}
