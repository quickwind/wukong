// Irix edition: Claude Code and Devin CLI are the only agent providers. Devin ships as a
// configured ACP provider, not a built-in, so upstream's provider code stays untouched.

import { isIrixActive } from "./policy.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type AgentProviderRuntimeSettingsMap,
  type ProviderLaunchAvailability,
  type ProviderOverride,
  type ResolvedProviderLaunch,
} from "../server/agent/provider-launch-config.js";

export const IRIX_PROVIDER_IDS: readonly string[] = ["claude", "devin", "opencode"];

// Providers a locally installed plugin may add. Each shows only while its plugin is loaded:
// the registry has the id only when the plugin registered it.
export const IRIX_PLUGIN_PROVIDER_IDS: readonly string[] = ["scripted"];

const DEFAULT_OVERRIDES: Record<string, ProviderOverride> = {
  devin: {
    extends: "acp",
    label: "Devin CLI",
    description: "Cognition's Devin for Terminal via Agent Client Protocol",
    command: ["devin", "acp"],
  },
};

// Whether the Claude command was missing when the daemon started. The registry is built
// synchronously and more than once, so the check runs once at startup and the answer is kept.
let claudeMissing = false;

type LaunchCheck = (launch: ResolvedProviderLaunch) => Promise<ProviderLaunchAvailability>;

/**
 * Looks for the Claude command the same way the Claude provider does (the user's configured
 * command first, else `claude` on PATH). Run once at daemon start; a Claude installed later is
 * picked up at the next start.
 */
export async function detectIrixProviders(
  runtimeSettings: AgentProviderRuntimeSettingsMap | undefined,
  check: LaunchCheck = checkProviderLaunchAvailable,
): Promise<void> {
  if (!isIrixActive()) {
    return;
  }
  const launch = await resolveProviderLaunch({
    commandConfig: runtimeSettings?.claude?.command,
    defaultBinary: "claude",
  });
  claudeMissing = !(await check(launch)).available;
}

export function resetIrixProviderDetection(): void {
  claudeMissing = false;
}

/** Adds the Irix providers; anything the user configured for them wins over the default. */
export function withIrixProviderOverrides(
  overrides: Record<string, ProviderOverride>,
): Record<string, ProviderOverride> {
  if (!isIrixActive()) {
    return overrides;
  }
  const merged = { ...overrides };
  for (const [id, fallback] of Object.entries(DEFAULT_OVERRIDES)) {
    merged[id] = { ...fallback, ...overrides[id] };
  }
  // A user's own enabled setting wins; detection only decides the default.
  if (claudeMissing && overrides.claude?.enabled === undefined) {
    merged.claude = { ...overrides.claude, enabled: false };
  }
  return merged;
}

/** Drops every provider outside the allowlist. Dev builds keep their mock providers. */
export function restrictToIrixProviders<T extends Record<string, unknown>>(
  registry: T,
  options: {
    isDev: boolean;
    devProviderIds: ReadonlySet<string>;
    registryOptions?: { pluginProviders?: Record<string, unknown> };
  },
): T {
  if (!isIrixActive()) {
    return registry;
  }
  return Object.fromEntries(
    Object.entries(registry).filter(
      ([id]) =>
        IRIX_PROVIDER_IDS.includes(id) ||
        (IRIX_PLUGIN_PROVIDER_IDS.includes(id) &&
          options.registryOptions?.pluginProviders?.[id] !== undefined) ||
        (options.isDev && options.devProviderIds.has(id)),
    ),
  ) as T;
}
