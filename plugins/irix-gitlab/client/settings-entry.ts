import type { PluginClientContext } from "@getpaseo/plugin/client";

export const GITLAB_SETTINGS_ID = "gitlab";

// Settings → Plugins lists only plugins installed from a folder, so a built-in plugin's settings
// screen has no menu to open it from. These are its entry points.
export function contributeSettingsEntry(client: PluginClientContext): () => void {
  return client.addCommandCenterItem({
    id: "gitlab-settings",
    title: "GitLab settings",
    icon: "GitBranch",
    keywords: ["gitlab", "token", "python-gitlab", "clone folder", "setup"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings(GITLAB_SETTINGS_ID);
    },
  });
}
