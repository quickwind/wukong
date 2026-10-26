import { useCallback, useState } from "react";
import { Alert, Text, View } from "react-native";
import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

type AgentToolsChannel = "cli" | "mcp";

const OPTIONS: { value: AgentToolsChannel; label: string }[] = [
  { value: "cli", label: "Irix tools" },
  { value: "mcp", label: "MCP" },
];

// The daemon fixes this to the command line unless IRIX_UNRESTRICTED or IRIX_ALLOW_AGENT_TOOLS is
// set, and then the row is not shown at all (server agent-tools-setting.ts).
export function IrixAgentToolsCard({ serverId }: { serverId: string }) {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [isSaving, setIsSaving] = useState(false);

  const configRecord = config as Record<string, unknown> | null;
  // From the daemon config: server_info.features drops fields the protocol does not list.
  const editable = configRecord?.agentToolsEditable === true;
  const stored = configRecord?.agentTools;
  const value: AgentToolsChannel = stored === "mcp" ? "mcp" : "cli";

  const handleValueChange = useCallback(
    (next: AgentToolsChannel) => {
      if (isSaving || next === value) {
        return;
      }
      setIsSaving(true);
      void patchConfig({ agentTools: next } as unknown as MutableDaemonConfigPatch)
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
    [isSaving, patchConfig, value],
  );

  if (!isConnected || !editable) {
    return null;
  }

  return (
    <View style={settingsStyles.card} testID="host-page-agent-tools-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Agent tools</Text>
          <Text style={settingsStyles.rowHint}>
            {value === "cli"
              ? "Agents are taught to use Irix tools to work with other agents. Use this where MCP servers are blocked. Applies to agents started after the change."
              : "Agents use the MCP tools the app passes in. Pick this only where agents may use MCP servers. Applies to agents started after the change."}
          </Text>
        </View>
        <SegmentedControl
          options={OPTIONS}
          value={value}
          onValueChange={handleValueChange}
          size="sm"
          testID="host-page-agent-tools-control"
        />
      </View>
    </View>
  );
}
