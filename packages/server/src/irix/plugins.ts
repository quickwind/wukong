// Irix edition: plugins load from local directories only. Installing from npm, Git, or a
// plugin registry runs child processes the egress guard cannot see, so managed sources are
// switched off. Of the bundled plugins only Irix's own start; the rest (extra providers,
// other vendors' usage readers) do not.

import { BuiltinPluginLoader } from "../server/plugins/builtin/index.js";
import type { ManagedPluginSources } from "../server/plugins/managed-source.js";
import { isIrixActive } from "./policy.js";

export function irixManagedSources(
  sources: ManagedPluginSources | undefined,
): ManagedPluginSources | undefined {
  return isIrixActive() ? undefined : sources;
}

export const IRIX_BUILTIN_PLUGINS: readonly string[] = [
  "irix-gitlab",
  "irix-devin-usage",
  "irix-claude-usage",
  "irix-context-hint",
  "irix-content-search",
];

export function irixBuiltinPlugins(
  loader: BuiltinPluginLoader | undefined,
): BuiltinPluginLoader | undefined {
  return isIrixActive() ? new BuiltinPluginLoader(undefined, IRIX_BUILTIN_PLUGINS) : loader;
}

/** What to tell a user whose install needs plugin source management, which Irix turns off. */
export function pluginSourcesUnavailableMessage(upstreamMessage: string): string {
  return isIrixActive()
    ? "Irix installs plugins from a local folder only, not from npm, GitHub or a registry. " +
        "Get the plugin's source onto this machine (for example with git clone), then run: " +
        "irix plugin install <folder>"
    : upstreamMessage;
}
