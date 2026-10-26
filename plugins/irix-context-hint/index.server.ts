import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DEFAULT_PREFERENCES } from "./shared/level.js";
import { preferences, preferencesRpc } from "./shared/preferences.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  server.handle(preferencesRpc, async () => {
    const current = await settings.read();
    return current.status === "ready" ? current.values : DEFAULT_PREFERENCES;
  });
  return () => {};
}
