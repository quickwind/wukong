import type {
  PluginButton,
  PluginButtonIcon,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { useMemo } from "react";
import { Image } from "react-native";
import {
  devinDesktopStatusRpc,
  openInDevinDesktopRpc,
  openInFileManagerRpc,
} from "../shared/rpc.js";

const BUTTON_ID = "open-in-devin";
const BUTTON_TITLE = "Open in Devin";
const EXPLORER_TITLE = "Open in File Explorer";
const FALLBACK_ICON = "SquareTerminal";
const EXPLORER_ICON = "FolderOpen";

interface WorkspaceEntry {
  id: string;
  directory: string;
}

export function createDevinIconComponent(dataUrl: string): ComponentType<PluginButtonIconProps> {
  return function DevinDesktopIcon({ size }: PluginButtonIconProps) {
    const style = useMemo(() => ({ width: size, height: size }), [size]);
    const source = useMemo(() => ({ uri: dataUrl }), []);
    return <Image source={source} style={style} resizeMode="contain" />;
  };
}

export function contributeDevinDesktopButton(client: PluginClientContext): () => void {
  let stopped = false;
  const workspaces = new Map<string, WorkspaceEntry>();
  const buttons = new Map<string, PluginButtonRegistration>();
  let commandCenterCleanup: (() => void) | null = null;
  let releaseSubscription: (() => Promise<void>) | null = null;
  let resolvedIcon: PluginButtonIcon | null = null;
  let devinInstalled = false;
  let statusKnown = false;

  function removeButton(workspaceId: string) {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  }

  // With Devin Desktop installed the button is a menu (Devin, File Explorer); without it, File
  // Explorer is the button itself.
  function buildButton(workspace: WorkspaceEntry): PluginButton {
    const directoryNow = () =>
      workspaces.get(workspace.id)?.directory?.trim() || workspace.directory;
    const openExplorer = async () => {
      await client.rpc(openInFileManagerRpc, { workspacePath: directoryNow() });
    };
    if (!devinInstalled) {
      return {
        title: EXPLORER_TITLE,
        icon: EXPLORER_ICON,
        behavior: { kind: "action", onPress: openExplorer },
      };
    }
    return {
      title: BUTTON_TITLE,
      icon: resolvedIcon ?? FALLBACK_ICON,
      behavior: {
        kind: "menu",
        items: [
          {
            kind: "item",
            id: "open-in-devin",
            title: BUTTON_TITLE,
            icon: resolvedIcon ?? FALLBACK_ICON,
            behavior: {
              kind: "action",
              async onPress() {
                await client.rpc(openInDevinDesktopRpc, { workspacePath: directoryNow() });
              },
            },
          },
          {
            kind: "item",
            id: "open-in-file-explorer",
            title: EXPLORER_TITLE,
            icon: EXPLORER_ICON,
            behavior: { kind: "action", onPress: openExplorer },
          },
        ],
      },
    };
  }

  function syncWorkspaceButton(workspace: WorkspaceEntry) {
    if (stopped || !statusKnown) return;
    const directory = workspace.directory?.trim();
    if (!directory) {
      removeButton(workspace.id);
      return;
    }
    if (buttons.has(workspace.id)) return;
    buttons.set(
      workspace.id,
      client.addHeaderButton({
        id: BUTTON_ID,
        workspaceId: workspace.id,
        button: buildButton(workspace),
      }),
    );
  }

  function syncAllButtons() {
    if (stopped || !statusKnown) return;
    for (const workspace of workspaces.values()) {
      syncWorkspaceButton(workspace);
    }
  }

  function finishStatus(installed: boolean, iconDataUrl: string | null) {
    if (stopped) return;
    devinInstalled = installed;
    if (installed) {
      resolvedIcon = iconDataUrl ? createDevinIconComponent(iconDataUrl) : FALLBACK_ICON;
    } else {
      resolvedIcon = null;
    }
    statusKnown = true;
    const cleanups: Array<() => void> = [];
    if (installed) {
      cleanups.push(
        client.addCommandCenterItem({
          id: BUTTON_ID,
          title: BUTTON_TITLE,
          icon: FALLBACK_ICON,
          keywords: ["devin", "ide", "editor", "desktop"],
          context: "workspace",
          async onSelect({ workspace, rpc }) {
            await rpc(openInDevinDesktopRpc, { workspacePath: workspace.directory });
          },
        }),
      );
    }
    cleanups.push(
      client.addCommandCenterItem({
        id: "open-in-file-explorer",
        title: EXPLORER_TITLE,
        icon: EXPLORER_ICON,
        keywords: ["explorer", "finder", "folder", "files", "directory"],
        context: "workspace",
        async onSelect({ workspace, rpc }) {
          await rpc(openInFileManagerRpc, { workspacePath: workspace.directory });
        },
      }),
    );
    commandCenterCleanup = () => {
      for (const cleanup of cleanups) cleanup();
    };
    syncAllButtons();
  }

  // Devin is optional: if its status cannot be read, File Explorer is still offered.
  void client
    .rpc(devinDesktopStatusRpc, {})
    .then((status) => finishStatus(status.installed, status.iconDataUrl))
    .catch((error) => {
      if (!stopped) {
        console.error("[irix-gitlab] Devin Desktop status check failed", error);
        finishStatus(false, null);
      }
    });

  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (stopped) {
        void subscription.release().catch(() => undefined);
        return undefined;
      }
      releaseSubscription = () => subscription.release();
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const button of buttons.values()) button.remove();
          buttons.clear();
          workspaces.clear();
          for (const entry of entries) {
            workspaces.set(entry.id, { id: entry.id, directory: entry.workspaceDirectory });
          }
          syncAllButtons();
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            workspaces.delete(update.id);
            removeButton(update.id);
          } else {
            const entry = {
              id: update.workspace.id,
              directory: update.workspace.workspaceDirectory,
            };
            workspaces.set(entry.id, entry);
            syncWorkspaceButton(entry);
          }
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!stopped) {
        console.error("[irix-gitlab] Workspace observation for Devin button failed", error);
      }
    });

  return () => {
    stopped = true;
    void releaseSubscription?.().catch(() => undefined);
    releaseSubscription = null;
    commandCenterCleanup?.();
    commandCenterCleanup = null;
    for (const button of buttons.values()) button.remove();
    buttons.clear();
    workspaces.clear();
  };
}
