import { useCallback, useState } from "react";
import { Alert, Text, View } from "react-native";
import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { HIDDEN_ROW_STYLE, IRIX_BUILD, upstreamOnly } from "@/irix/build";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";

export { HIDDEN_ROW_STYLE, IRIX_BUILD, upstreamOnly };

export function irixAgentsCard<Component>(component: Component): Component {
  return IRIX_BUILD ? (IrixSubagentApprovalCard as unknown as Component) : component;
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
          Alert.alert("无法更新设置", error instanceof Error ? error.message : String(error));
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
          <Text style={settingsStyles.rowTitle}>强制子代理人工审批</Text>
          <Text style={settingsStyles.rowHint}>
            {enabled
              ? "全局强制拦截所有子代理派生请求，必须经过人工确认后方可执行。"
              : "未开启全局强制审批，子代理派生将根据各个场景的具体设置（如 ask 模式或 bypass 模式）进行控制。"}
          </Text>
        </View>
        <Switch
          value={enabled}
          disabled={locked || isSaving}
          onValueChange={handleValueChange}
          accessibilityLabel="强制子代理人工审批"
          testID="host-page-subagent-approval-switch"
        />
      </View>
    </View>
  );
}
