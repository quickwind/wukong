import { useCallback, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Search } from "lucide-react-native";
import { ContextMenu } from "@/components/ui/context-menu";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { Theme } from "@/styles/theme";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { IRIX_BUILD } from "./build";
import type { Match } from "./content-search";
import { toggleContentSearch, useContentSearchOpen } from "./content-search-open";
import { IrixContentSearchPanel } from "./content-search-panel";
import { openSearchMatch } from "./open-search-match";

// The Files pane's only plumbing for content search. `file-explorer-pane.tsx` calls `useSearch`,
// renders `button` in its toolbar and swaps its tree's `ContextMenu` tag for `TreeMenu`, so the
// upstream file carries one element per spot and none of this.

const ThemedSearch = withUnistyles(Search);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

/** The toolbar button, and the panel to show in place of the tree (null while closed). */
export interface FilesSearch {
  button: ReactNode;
  panel: ReactElement | null;
}

function useIrixFilesSearch(
  serverId: string,
  workspaceId: string | null | undefined,
  cwd: string,
): FilesSearch {
  const isCompact = useIsCompactFormFactor();
  const key = `${serverId}:${workspaceId ?? ""}`;
  const open = useContentSearchOpen(key);
  const client = useHostRuntimeClient(serverId);
  const toggle = useCallback(() => toggleContentSearch(key), [key]);
  const onOpenMatch = useCallback(
    (match: Match) =>
      openSearchMatch({
        match,
        persistenceKey: workspaceId
          ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
          : null,
        openWorkspaceTabInFocusedPane: (workspaceKey, target, placement) =>
          useWorkspaceLayoutStore.getState().openTab({
            workspaceKey,
            target,
            intent: "reveal",
            placement,
          }),
        revealWorkspaceTab,
      }),
    [serverId, workspaceId],
  );

  const button = (
    <ToolbarButton
      label="Search in files"
      selected={open}
      compact={isCompact}
      hitSlop={8}
      testID="files-search"
      onPress={toggle}
    >
      <ThemedSearch size={paneContentToolbarIconSize(isCompact)} uniProps={iconColorMapping} />
    </ToolbarButton>
  );
  if (!open) return { button, panel: null };
  // Without a client the panel would sit idle and ask for a longer query, whatever was typed.
  const panel = client ? (
    <IrixContentSearchPanel
      serverId={serverId}
      workspaceId={workspaceId ?? null}
      cwd={cwd}
      onOpenMatch={onOpenMatch}
    />
  ) : (
    <View style={styles.centerState}>
      <Text style={styles.muted}>Connect to the host to search</Text>
    </View>
  );
  return { button, panel };
}

function noFilesSearch(): undefined {
  return undefined;
}

/** Content search for the Files pane; `undefined` in an upstream build, which calls no hooks. */
export const useSearch: (
  serverId: string,
  workspaceId: string | null | undefined,
  cwd: string,
) => FilesSearch | undefined = IRIX_BUILD ? useIrixFilesSearch : noFilesSearch;

type TreeMenuProps = ComponentProps<typeof ContextMenu> & { search?: FilesSearch };

function IrixTreeMenu({ search, ...props }: TreeMenuProps): ReactElement {
  if (search?.panel) return search.panel;
  return <ContextMenu {...props} />;
}

/**
 * The tree's `ContextMenu`, or the search panel in its place while search is open. In an upstream
 * build this is `ContextMenu` itself, which ignores `search`.
 */
export const TreeMenu: (props: TreeMenuProps) => ReactElement = IRIX_BUILD
  ? IrixTreeMenu
  : ContextMenu;

const styles = StyleSheet.create((theme) => ({
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
