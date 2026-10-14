import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";

import { isIrixActive } from "../policy.js";
import { defaultConfig } from "./adapter.js";
import { matchesGitLabForgeHost, type GitLabForgeConfig } from "./config.js";

/**
 * Irix clones only from the company GitLab. The daemon's clone request runs `git clone` in a
 * child process the egress guard cannot see, and accepts any remote URL, so the host is checked
 * here.
 */
export function assertCloneAllowed(
  cloneUrl: string,
  getConfig: () => GitLabForgeConfig | null = defaultConfig,
): void {
  if (!isIrixActive()) {
    return;
  }
  const config = getConfig();
  const host = parseGitRemoteLocation(cloneUrl)?.host;
  if (!config) {
    throw new Error(
      'GitLab is not configured. Set "gitlab.url" in irix.json in the Paseo home, or IRIX_GITLAB_URL.',
    );
  }
  if (!host || !matchesGitLabForgeHost(config, host)) {
    throw new Error(
      `Irix only clones from ${new URL(config.url).host}. Use "Add project from GitLab".`,
    );
  }
}
