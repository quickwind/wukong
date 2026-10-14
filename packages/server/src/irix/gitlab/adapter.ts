// Irix: the forge registry holds one adapter, the company GitLab, served by upstream's
// GitLab service driving python-gitlab through the glab-compatible runner.

import type { ForgeAdapterRegistration } from "../../services/forge-registry.js";
import { createGitLabService } from "../../services/gitlab-service.js";
import { resolvePaseoHome } from "../../server/paseo-home.js";
import { isIrixActive } from "../policy.js";
import { loadGitLabForgeConfig, matchesGitLabForgeHost, type GitLabForgeConfig } from "./config.js";
import { createGlabCompatRunner } from "./glab-runner.js";
import { createGitLabPythonClient } from "./python-client.js";

// Read once: a changed irix.json / wukong.json takes effect when the daemon restarts.
let cachedConfig: GitLabForgeConfig | null | undefined;

export function defaultConfig(): GitLabForgeConfig | null {
  cachedConfig ??= loadGitLabForgeConfig(resolvePaseoHome());
  return cachedConfig;
}

export function createIrixGitLabAdapter(
  getConfig: () => GitLabForgeConfig | null = defaultConfig,
): ForgeAdapterRegistration {
  return {
    createService() {
      const config = getConfig();
      if (!config) {
        throw new Error(
          'GitLab is not configured. Set "gitlab.url" in irix.json in the Paseo home or IRIX_GITLAB_URL.',
        );
      }
      return createGitLabService({
        runner: createGlabCompatRunner(createGitLabPythonClient({ config })),
        resolveGlabPath: async () => "python-gitlab",
      });
    },
    matchesHost(host) {
      const config = getConfig();
      return config ? matchesGitLabForgeHost(config, host) : false;
    },
  };
}

export const createWukongGitLabAdapter = createIrixGitLabAdapter;

type ForgeEntry = readonly [string, ForgeAdapterRegistration];

/** Upstream's adapters unless Irix is active, in which case GitLab is the only forge. */
export function irixForgeEntries(
  upstream: ForgeEntry[],
  adapter: ForgeAdapterRegistration = createIrixGitLabAdapter(),
): ForgeEntry[] {
  return isIrixActive() ? [["gitlab", adapter]] : upstream;
}

export const wukongForgeEntries = irixForgeEntries;
