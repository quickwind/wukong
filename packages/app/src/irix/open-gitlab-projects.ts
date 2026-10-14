import { useRouter } from "expo-router";
import { useCallback } from "react";

import { buildPluginSurfaceRoute } from "@/plugins/routes";

const GITLAB_PLUGIN_ID = "irix-gitlab";
const GITLAB_SCREEN_ID = "add-from-gitlab";

export function buildGitLabProjectsRoute(serverId: string) {
  return buildPluginSurfaceRoute(serverId, GITLAB_PLUGIN_ID, {
    kind: "surface",
    id: GITLAB_SCREEN_ID,
  });
}

/**
 * Irix clones from the company GitLab through the bundled plugin's screen. Add Project keeps
 * its folder search and new-directory options; its GitHub entry becomes this one.
 */
export function useOpenGitLabProjects(onClose: () => void): (serverId: string) => void {
  const router = useRouter();
  return useCallback(
    (serverId: string) => {
      router.push(buildGitLabProjectsRoute(serverId));
      onClose();
    },
    [onClose, router],
  );
}
