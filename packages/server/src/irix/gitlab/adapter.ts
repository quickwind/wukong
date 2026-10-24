// Irix: the forge registry holds one adapter, the company GitLab, served by upstream's
// GitLab service driving the REST client (gitbeaker) through the glab-compatible runner.

import type { ForgeAdapterRegistration } from "../../services/forge-registry.js";
import { createGitLabService } from "../../services/gitlab-service.js";
import { resolvePaseoHome } from "../../server/paseo-home.js";
import { isIrixActive } from "../policy.js";
import { loadGitLabForgeConfig, matchesGitLabForgeHost, type GitLabForgeConfig } from "./config.js";
import { createGlabCompatRunner } from "./glab-runner.js";
import { createGitLabRestClient } from "./rest-client.js";
import { draftPullRequestTextForCheckout } from "../pr-text.js";
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
      // A checkout with an `upstream` remote proposes its branch there, on GitLab's own page, which
      // fills in the title and description. Without one the API needs a title, so draft it now.
      const createPullRequest = service.createPullRequest.bind(service);
      service.createPullRequest = async (input) => {
        await openUpstreamMergeRequestPage(
          { config, client, launch },
          { cwd: input.cwd, head: input.head, title: input.title, body: input.body },
        );
        if (input.title) {
          return createPullRequest(input);
        }
        const draft = await draftPullRequestTextForCheckout(input.cwd);
        return createPullRequest({ ...input, title: draft.title, body: input.body || draft.body });
      };
      const getCurrentPullRequestStatus = service.getCurrentPullRequestStatus.bind(service);
      service.getCurrentPullRequestStatus = async (input) =>
        withoutAbandonedMergeRequest(await getCurrentPullRequestStatus(input));
      return service;
    },
    matchesHost(host) {
      const config = getConfig();
      return config ? matchesGitLabForgeHost(config, host) : false;
    },
  };
}

type ForgeEntry = readonly [string, ForgeAdapterRegistration];

/**
 * Upstream keeps showing a closed merge request as the branch's current one for as long as the
 * branch is at the commit it had (the button stays "View merge request"). A merge request that was
 * closed without merging is over, so Irix reports none and the button offers to create a new one.
 * A merged request still shows, as merged.
 */
export function withoutAbandonedMergeRequest<T extends { state: string; isMerged: boolean }>(
  status: T | null,
): T | null {
  return status && status.state === "closed" && !status.isMerged ? null : status;
}

/** Upstream's adapters unless Irix is active, in which case GitLab is the only forge. */
export function irixForgeEntries(
  upstream: ForgeEntry[],
  adapter: ForgeAdapterRegistration = createIrixGitLabAdapter(),
): ForgeEntry[] {
  return isIrixActive() ? [["gitlab", adapter]] : upstream;
}
