import { useEffect } from "react";
import type { PluginScreenProps } from "@getpaseo/plugin/client";

export const OPEN_AGENT_SCREEN_ID = "open-agent";

// Menu callbacks have no navigation, but screens do. The pill opens this screen with the new
// agent's id and it hands over to the agent's tab straight away.
export function OpenAgentScreen({ params, navigation }: PluginScreenProps) {
  const agentId = params.agentId;
  useEffect(() => {
    if (agentId) navigation?.openAgent({ agentId });
  }, [agentId, navigation]);
  return null;
}
