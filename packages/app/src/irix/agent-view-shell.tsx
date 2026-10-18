import React, { useEffect, useId, useLayoutEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { AgentConversationPanel } from "@/panels/agent-panel";
import {
  createPaneFocusContextValue,
  PaneFocusProvider,
  PaneProvider,
  type PaneContextValue,
} from "@/panels/pane-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";

export interface AgentViewProps {
  agentId: string;
  serverId: string;
  workspaceId: string;
  onOpenWorkspaceFile?: (request: WorkspaceFileOpenRequest) => void;
}

const noop = () => {};

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
});

// A plugin screen is never a workspace tab, and it is on screen while it is mounted.
const PANE_FOCUS = createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true });

/**
 * What `WorkspacePaneContent` and `workspace-screen` give a chat tab, for a chat that is not
 * one. The timeline subscription is the part that matters: without a registered viewer the
 * conversation waits forever for history. Each instance registers under its own source id, so
 * two views of different agents do not release each other's subscription.
 */
export function AgentViewShell({
  agentId,
  serverId,
  workspaceId,
  onOpenWorkspaceFile,
}: AgentViewProps) {
  const instanceId = useId();
  const sourceId = `plugin-agent-view:${instanceId}`;
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );

  useEffect(() => {
    void getHostRuntimeStore()
      .prepareAgentTimeline(serverId, agentId)
      .catch(() => undefined);
  }, [serverId, agentId]);

  useLayoutEffect(() => {
    if (!viewedTimelineSync) {
      return undefined;
    }
    viewedTimelineSync.replaceVisibleAgentIds(sourceId, [agentId]);
    return () => viewedTimelineSync.replaceVisibleAgentIds(sourceId, []);
  }, [viewedTimelineSync, sourceId, agentId]);

  const pane = useMemo<PaneContextValue>(
    () => ({
      serverId,
      workspaceId,
      host: "main",
      tabId: sourceId,
      target: { kind: "agent", agentId },
      openTab: noop,
      openPreferredTarget: noop,
      closeCurrentTab: noop,
      retargetCurrentTab: noop,
      setCurrentTabState: noop,
      openFileInWorkspace: onOpenWorkspaceFile ?? noop,
      openImportSheet: noop,
    }),
    [agentId, onOpenWorkspaceFile, serverId, sourceId, workspaceId],
  );

  return (
    <PaneProvider value={pane}>
      <PaneFocusProvider value={PANE_FOCUS}>
        <View style={styles.fill}>
          <AgentConversationPanel key={`${serverId}:${agentId}`} />
        </View>
      </PaneFocusProvider>
    </PaneProvider>
  );
}
