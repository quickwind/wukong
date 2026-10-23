// Irix: the forge registry holds one adapter, the company GitLab, served by upstream's
// GitLab service driving the REST client (gitbeaker) through the glab-compatible runner.

import type { ForgeAdapterRegistration } from "../../services/forge-registry.js";
import { createGitLabService } from "../../services/gitlab-service.js";
import { resolvePaseoHome } from "../../server/paseo-home.js";
import { isIrixActive } from "../policy.js";
import { loadGitLabForgeConfig, matchesGitLabForgeHost, type GitLabForgeConfig } from "./config.js";
import { createGlabCompatRunner } from "./glab-runner.js";
import { createGitLabRestClient } from "./rest-client.js";
import { openUpstreamMergeRequestPage, type LaunchBrowser } from "./upstream-merge-request.js";

// Read once: a changed irix.json takes effect when the daemon restarts.
let cachedConfig: GitLabForgeConfig | null | undefined;

export function defaultConfig(): GitLabForgeConfig | null {
  cachedConfig ??= loadGitLabForgeConfig(resolvePaseoHome());
  return cachedConfig;
}

export function createIrixGitLabAdapter(
  getConfig: () => GitLabForgeConfig | null = defaultConfig,
  /** Test seam: replaces opening the default browser. */
  launch?: LaunchBrowser,
): ForgeAdapterRegistration {
  return {
    createService() {
      const config = getConfig();
      if (!config) {
        throw new Error(
          'GitLab is not configured. Set "gitlab.url" in irix.json in the Paseo home or IRIX_GITLAB_URL.',
        );
      }
      const client = createGitLabRestClient({ config });
      const service = createGitLabService({
        runner: createGlabCompatRunner(client),
        resolveGlabPath: async () => "gitlab-rest",
      });
      // A checkout with an `upstream` remote proposes its branch there, on GitLab's own page.
      const createPullRequest = service.createPullRequest.bind(service);
      service.createPullRequest = async (input) => {
        await openUpstreamMergeRequestPage(
          { config, client, launch },
          { cwd: input.cwd, head: input.head, title: input.title, body: input.body },
        );
        return createPullRequest(input);
      };
      return service;
    },
    matchesHost(host) {
      const config = getConfig();
      return config ? matchesGitLabForgeHost(config, host) : false;
    },
  };
}

type ForgeEntry = readonly [string, ForgeAdapterRegistration];

/** Upstream's adapters unless Irix is active, in which case GitLab is the only forge. */
export function irixForgeEntries(
  upstream: ForgeEntry[],
  adapter: ForgeAdapterRegistration = createIrixGitLabAdapter(),
): ForgeEntry[] {
  return isIrixActive() ? [["gitlab", adapter]] : upstream;
}
