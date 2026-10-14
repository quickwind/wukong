// Irix edition: Claude Code and Devin CLI are the only agent providers. Devin ships as a
// configured ACP provider, not a built-in, so upstream's provider code stays untouched.

import { isIrixActive } from "./policy.js";
import type { ProviderOverride } from "../server/agent/provider-launch-config.js";

export const IRIX_PROVIDER_IDS: readonly string[] = ["claude", "devin"];
export const WUKONG_PROVIDER_IDS = IRIX_PROVIDER_IDS;

const DEFAULT_OVERRIDES: Record<string, ProviderOverride> = {
  devin: {
    extends: "acp",
    label: "Devin CLI",
    description: "Cognition's Devin for Terminal via Agent Client Protocol",
    command: ["devin", "acp"],
  },
};

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
  return merged;
}

/** Drops every provider outside the allowlist. Dev builds keep their mock providers. */
export function restrictToIrixProviders<T extends Record<string, unknown>>(
  registry: T,
  options: { isDev: boolean; devProviderIds: ReadonlySet<string> },
): T {
  if (!isIrixActive()) {
    return registry;
  }
  return Object.fromEntries(
    Object.entries(registry).filter(
      ([id]) => IRIX_PROVIDER_IDS.includes(id) || (options.isDev && options.devProviderIds.has(id)),
    ),
  ) as T;
}

export const withWukongProviderOverrides = withIrixProviderOverrides;
export const restrictToWukongProviders = restrictToIrixProviders;
