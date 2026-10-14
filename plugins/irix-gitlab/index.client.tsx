import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AddFromGitLabScreen } from "./client/screen.js";

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

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: SCREEN_ID, title: TITLE, Component: AddFromGitLabScreen });
  client.addSidebarHeaderItem({ id: SCREEN_ID, title: TITLE, Component: AddFromGitLabItem });
  return () => {};
}
