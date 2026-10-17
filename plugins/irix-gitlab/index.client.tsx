import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { contributeDevinDesktopButton } from "./client/devin-desktop-button.js";
import { AddFromGitLabScreen } from "./client/screen.js";
import { contributeSettingsEntry, GITLAB_SETTINGS_ID } from "./client/settings-entry.js";
import { GitLabSetupScreen } from "./client/setup-screen.js";

const SCREEN_ID = "add-from-gitlab";
const TITLE = "Add project from GitLab";

function AddFromGitLabItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const open = useCallback(() => openScreen({ screenId: SCREEN_ID }), [openScreen]);
  return (
    <SidebarRow
      icon="GitBranch"
      label={TITLE}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={open}
    />
  );
}

function settingsOpener(client: PluginClientContext): () => void {
  return () => client.openSettings(GITLAB_SETTINGS_ID);
}

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: GITLAB_SETTINGS_ID,
    title: "GitLab",
    icon: "GitBranch",
    Component: GitLabSetupScreen,
  });
  const openGitLabSettings = settingsOpener(client);
  const Screen = (props: PluginScreenProps) => (
    <AddFromGitLabScreen {...props} openGitLabSettings={openGitLabSettings} />
  );
  client.addScreen({ id: SCREEN_ID, title: TITLE, Component: Screen });
  client.addSidebarHeaderItem({ id: SCREEN_ID, title: TITLE, Component: AddFromGitLabItem });
  const removeSettingsEntry = contributeSettingsEntry(client);
  const removeDevinButton = contributeDevinDesktopButton(client);
  return () => {
    removeSettingsEntry();
    removeDevinButton();
  };
}
