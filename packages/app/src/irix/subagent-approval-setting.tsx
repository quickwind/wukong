import React, { useCallback, useState } from "react";
import { Alert, Text, View } from "react-native";
import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { IrixIdleReleaseCard } from "@/irix/idle-release-setting";
import { HIDDEN_ROW_STYLE, IRIX_BUILD, upstreamOnly } from "@/irix/build";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";

export { HIDDEN_ROW_STYLE, IRIX_BUILD, upstreamOnly };

function IrixAgentsCards({ serverId }: { serverId: string }) {
  return (
    <>
      <IrixSubagentApprovalCard serverId={serverId} />
      <IrixIdleReleaseCard serverId={serverId} />
    </>
  );
}

export function irixAgentsCard<Component>(component: Component): Component {
  return IRIX_BUILD ? (IrixAgentsCards as unknown as Component) : component;
}

export function IrixSubagentApprovalCard({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const features = useSessionStore(
    (state) =>
      state.sessions[serverId]?.serverInfo?.features as
        | {
            subagentApprovalLocked?: boolean;
            requireSubagentApproval?: boolean;
          }
        | undefined,
  );
  const [isSaving, setIsSaving] = useState(false);

  const configRecord = config as Record<string, unknown> | null;
  let locked = true;
  if (typeof features?.subagentApprovalLocked === "boolean") {
    locked = features.subagentApprovalLocked;
  } else if (typeof configRecord?.subagentApprovalLocked === "boolean") {
    locked = configRecord.subagentApprovalLocked;
  }

  let persistedEnabled = true;
  if (typeof configRecord?.requireSubagentApproval === "boolean") {
    persistedEnabled = configRecord.requireSubagentApproval;
  } else if (typeof features?.requireSubagentApproval === "boolean") {
    persistedEnabled = features.requireSubagentApproval;
  }

  const enabled = locked ? true : persistedEnabled;

  const handleValueChange = useCallback(
    (next: boolean) => {
      if (locked || isSaving) {
        return;
      }
      setIsSaving(true);
      void patchConfig({
        requireSubagentApproval: next,
      } as unknown as MutableDaemonConfigPatch)
        .catch((error) => {
          Alert.alert(
            "Unable to update setting",
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          setIsSaving(false);
        });
    },
    [isSaving, locked, patchConfig],
  );

  if (!isConnected) {
    return null;
  }

  return (
    <View style={settingsStyles.card} testID="host-page-subagent-approval-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Require Subagent Approval</Text>
          <Text style={settingsStyles.rowHint}>
            {enabled
              ? "Require human approval before spawning subagents or running CLI agent tasks."
              : "Global mandatory approval is disabled. Subagent execution is controlled by individual scenario settings."}
          </Text>
        </View>
        <Switch
          value={enabled}
          disabled={locked || isSaving}
          onValueChange={handleValueChange}
          accessibilityLabel="Require Subagent Approval"
          testID="host-page-subagent-approval-switch"
        />
      </View>
    </View>
  );
}
