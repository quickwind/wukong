import type {
  PluginButtonIcon,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { useMemo } from "react";
import { Image } from "react-native";
import { devinDesktopStatusRpc, openInDevinDesktopRpc } from "../shared/rpc.js";

const BUTTON_ID = "open-in-devin";
const BUTTON_TITLE = "Open in Devin";
const FALLBACK_ICON = "SquareTerminal";

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

  function removeButton(workspaceId: string) {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  }

  function syncWorkspaceButton(workspace: WorkspaceEntry) {
    if (stopped || !resolvedIcon) return;
    const directory = workspace.directory?.trim();
    if (!directory) {
      removeButton(workspace.id);
      return;
    }
    if (buttons.has(workspace.id)) return;
    const registration = client.addHeaderButton({
      id: BUTTON_ID,
      workspaceId: workspace.id,
      button: {
        title: BUTTON_TITLE,
        icon: resolvedIcon,
        behavior: {
          kind: "action",
          async onPress() {
            const currentDir = workspaces.get(workspace.id)?.directory?.trim() || directory;
            await client.rpc(openInDevinDesktopRpc, { workspacePath: currentDir });
          },
        },
      },
    });
    buttons.set(workspace.id, registration);
  }

  function syncAllButtons() {
    if (stopped || !resolvedIcon) return;
    for (const workspace of workspaces.values()) {
      syncWorkspaceButton(workspace);
    }
  }

  void client
    .rpc(devinDesktopStatusRpc, {})
    .then((status) => {
      if (stopped || !status.installed) return undefined;
      resolvedIcon = status.iconDataUrl
        ? createDevinIconComponent(status.iconDataUrl)
        : FALLBACK_ICON;
      commandCenterCleanup = client.addCommandCenterItem({
        id: BUTTON_ID,
        title: BUTTON_TITLE,
        icon: FALLBACK_ICON,
        keywords: ["devin", "ide", "editor", "desktop"],
        context: "workspace",
        async onSelect({ workspace, rpc }) {
          await rpc(openInDevinDesktopRpc, { workspacePath: workspace.directory });
        },
      });
      syncAllButtons();
      return undefined;
    })
    .catch((error) => {
      if (!stopped) {
        console.error("[irix-gitlab] Devin Desktop status check failed", error);
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
