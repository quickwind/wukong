// Irix edition: what a resumed Claude or Devin session keeps from the time its agent was created.
//
// A guide is fixed when an agent is created (agent-guide.ts), and so is whether it has Paseo's MCP
// server: the agent was told one thing at creation, and a server that followed the setting at
// each resume could contradict it. Claude Code also ignores a new appended system prompt on resume
// (checked with the real Claude CLI: created with "the secret word is ALPHA", resumed with
// "BRAVO", it still answers ALPHA), and Devin keeps the guide in its session history.
//
// So a resume reads the guide the agent was created with from its stored metadata (both providers
// persist `daemonAppendSystemPrompt` there), passes it through unchanged, and gives the agent
// Paseo's MCP server, and the per-agent tool policy that lets it use it, only if that guide is not
// the command-line one. The server entry is built fresh: its token changes at every daemon start.
// An agent made before this existed has no guide and counts as MCP, as it always was.

import type { AgentSessionConfig, McpServerConfig } from "../server/agent/agent-sdk-types.js";
import { withRuntimePaseoMcpServer } from "../server/agent/runtime-mcp-config.js";
import { guideChannelOf } from "./agent-guide.js";

const PASEO_MCP_SERVER_NAME = "paseo";

export interface ResumeOverrides {
  daemonAppendSystemPrompt?: string;
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * What the agent manager knows about agent MCP connections, read off it: the daemon's address and
 * token, and the per-agent tool policy the MCP route consults (`getPaseoToolPolicy`).
 */
interface McpEndpoint {
  mcpBaseUrl?: string | null;
  mcpAuthToken?: string | null;
  paseoToolPolicies?: Map<string, { enabled?: boolean } | undefined>;
}

let agentManager: McpEndpoint | null = null;

/** Called from `attachIrixAgentManager`, which runs before every create and resume. */
export function resetAgentManagerForTests(): void {
  agentManager = null;
}

export function rememberAgentManagerForGuide(manager: unknown): void {
  if (manager && typeof manager === "object") {
    agentManager = manager as McpEndpoint;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The resume overrides with the guide and the MCP server the agent was created with. */
export function withResumedAgentTools(
  handle: unknown,
  overrides: ResumeOverrides | undefined,
  agentId: string | undefined,
): ResumeOverrides {
  const metadata = isRecord(handle) && isRecord(handle.metadata) ? handle.metadata : {};
  const storedGuide =
    typeof metadata.daemonAppendSystemPrompt === "string"
      ? metadata.daemonAppendSystemPrompt
      : undefined;
  const channel = guideChannelOf(storedGuide);
  const next: ResumeOverrides = { ...overrides };
  // The manager has just set this agent's tool policy from the current setting; in the command-line
  // setting that is "off", which would leave an agent made over MCP connected but with no tools.
  const policies = agentManager?.paseoToolPolicies;
  if (channel === "mcp" && agentId && policies) {
    policies.set(agentId, { ...policies.get(agentId), enabled: true });
  }
  if (storedGuide !== undefined) {
    next.daemonAppendSystemPrompt = storedGuide;
  }

  // Overrides replace the stored servers as a whole, so rebuild the list: everything but Paseo's own
  // server from the overrides (or, without any, from the stored ones), then Paseo's own if wanted.
  const stored = isRecord(metadata.mcpServers) ? metadata.mcpServers : {};
  const current = overrides?.mcpServers ?? stored;
  const others = Object.fromEntries(
    Object.entries(current).filter(([name]) => name !== PASEO_MCP_SERVER_NAME),
  ) as Record<string, McpServerConfig>;
  const withPaseo =
    channel === "mcp" && agentId
      ? withRuntimePaseoMcpServer({
          config: { mcpServers: others } as AgentSessionConfig,
          agentId,
          mcpBaseUrl: agentManager?.mcpBaseUrl ?? null,
          mcpAuthToken: agentManager?.mcpAuthToken ?? null,
        }).mcpServers
      : others;
  next.mcpServers = withPaseo ?? others;
  return next;
}
