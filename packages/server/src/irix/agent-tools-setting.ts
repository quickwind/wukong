/* oxlint-disable paseo/no-sync-io -- Irix: small config/credential reads outside the request path. */
// Irix edition: how Claude and Devin agents reach Paseo's agent tools. Company machines may bar
// both from MCP servers a client passes in, and they drop them without a word, so the daemon cannot
// find out. The answer is a setting: "cli" (the default) teaches the agent the `irix` command line,
// "mcp" leaves the tools to Paseo's MCP server. It is fixed to "cli", and the app hides it, unless
// IRIX_UNRESTRICTED or IRIX_ALLOW_AGENT_TOOLS is set in the daemon's environment.
// Stored as `daemon.agentTools` in `<home>/daemon.json` and read when a session starts. Each Claude
// agent keeps the guide and the MCP choice it was created with (claude-agent-guide.ts).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AgentToolsChannel } from "./agent-guide.js";
import { isIrixRestricted } from "./restrictions.js";

export const DEFAULT_AGENT_TOOLS: AgentToolsChannel = "cli";
const AGENT_TOOLS_PROVIDER_IDS = ["claude", "devin"] as const;

interface ConfigStoreLike {
  get(): object;
  patch(p: Record<string, unknown>): object;
}

interface AgentToolsWsServer {
  paseoHome?: string;
  daemonConfigStore?: ConfigStoreLike;
  broadcastCapabilitiesUpdate?(): void;
  broadcastDaemonConfigChanged?(config: object): void;
}

let runtimePaseoHome: string | null = null;
let cached: AgentToolsChannel | null = null;
const wrappedStores = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isChannel(value: unknown): value is AgentToolsChannel {
  return value === "cli" || value === "mcp";
}

function resolveConfigFilePath(paseoHome?: string | null): string | null {
  const home = paseoHome ?? runtimePaseoHome ?? process.env.PASEO_HOME;
  if (!home || !home.trim()) {
    return null;
  }
  return path.join(home.trim(), "daemon.json");
}

/** Strips a UTF-8 BOM (PowerShell 5 `Set-Content -Encoding UTF8` writes one), like upstream. */
function readConfigText(filePath: string): string {
  return readFileSync(filePath, "utf8").replace(/^﻿/, "");
}

function readPersisted(): AgentToolsChannel {
  const filePath = resolveConfigFilePath();
  if (!filePath || !existsSync(filePath)) {
    return DEFAULT_AGENT_TOOLS;
  }
  try {
    const raw: unknown = JSON.parse(readConfigText(filePath));
    const daemon = isRecord(raw) ? raw.daemon : undefined;
    const stored = isRecord(daemon) ? daemon.agentTools : undefined;
    return isChannel(stored) ? stored : DEFAULT_AGENT_TOOLS;
  } catch {
    return DEFAULT_AGENT_TOOLS;
  }
}

function writePersisted(channel: AgentToolsChannel): void {
  const filePath = resolveConfigFilePath();
  if (!filePath) {
    return;
  }
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    let current: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      try {
        const parsed: unknown = JSON.parse(readConfigText(filePath));
        if (isRecord(parsed)) {
          current = parsed;
        }
      } catch {
        current = {};
      }
    }
    const daemon = isRecord(current.daemon) ? { ...current.daemon } : {};
    daemon.agentTools = channel;
    current.daemon = daemon;
    writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  } catch {
    // Keep the in-memory setting even if disk persistence fails.
  }
}

/** Whether the setting may be changed (and is shown in the app). */
export function isAgentToolsEditable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isIrixRestricted("agentToolsControl", env);
}

/** The channel in force: always "cli" while the setting is locked. */
export function getAgentToolsChannel(env: NodeJS.ProcessEnv = process.env): AgentToolsChannel {
  if (!isAgentToolsEditable(env)) {
    return DEFAULT_AGENT_TOOLS;
  }
  if (cached === null) {
    cached = readPersisted();
  }
  return cached;
}

export function setAgentToolsChannel(
  channel: unknown,
  env: NodeJS.ProcessEnv = process.env,
): AgentToolsChannel {
  if (!isChannel(channel)) {
    throw new Error('agentTools must be "cli" or "mcp"');
  }
  if (!isAgentToolsEditable(env)) {
    throw new Error("How agents reach the agent tools is fixed on this daemon.");
  }
  cached = channel;
  writePersisted(channel);
  return channel;
}

/**
 * While agents are taught the command line they are not handed Paseo's MCP server or in-process
 * tools: the guide says they have none, and an agent that sees both reaches for whichever it saw
 * first. The agent manager reads the per-provider `paseoTools.enabled` from this store each time it
 * starts or resumes a session, so changing what `get()` returns is enough and nothing upstream moves.
 */
function withoutMcpTools<T extends object>(config: T): T {
  if (getAgentToolsChannel() !== "cli") {
    return config;
  }
  const providers = (config as { providers?: Record<string, { paseoTools?: object }> }).providers;
  const next: Record<string, { paseoTools?: object }> = { ...providers };
  for (const id of AGENT_TOOLS_PROVIDER_IDS) {
    next[id] = { ...next[id], paseoTools: { ...next[id]?.paseoTools, enabled: false } };
  }
  return { ...config, providers: next };
}

/** The fields the app reads, in both the daemon config and `server_info.features`. */
export function agentToolsFields(): {
  agentTools: AgentToolsChannel;
  agentToolsEditable: boolean;
} {
  return {
    agentTools: getAgentToolsChannel(),
    agentToolsEditable: isAgentToolsEditable(),
  };
}

export function wrapAgentToolsConfigStore(wsServer: AgentToolsWsServer): void {
  if (wsServer.paseoHome && wsServer.paseoHome !== runtimePaseoHome) {
    runtimePaseoHome = wsServer.paseoHome;
    // A read made before the home was known holds the default; drop it so the next read hits disk.
    cached = null;
  }
  const store = wsServer.daemonConfigStore;
  if (!store || typeof store.get !== "function" || typeof store.patch !== "function") {
    return;
  }
  if (wrappedStores.has(store)) {
    return;
  }
  wrappedStores.add(store);
  const originalGet = store.get.bind(store);
  const originalPatch = store.patch.bind(store);

  store.get = () => withoutMcpTools({ ...originalGet(), ...agentToolsFields() });

  store.patch = (patch: Record<string, unknown>) => {
    const { agentTools, ...rest } = patch;
    const changed = agentTools !== undefined;
    if (changed) {
      setAgentToolsChannel(agentTools);
    }
    const merged = { ...originalPatch(rest), ...agentToolsFields() };
    if (changed) {
      wsServer.broadcastCapabilitiesUpdate?.();
      wsServer.broadcastDaemonConfigChanged?.(merged);
    }
    return merged;
  };
}

export function resetAgentToolsForTests(): void {
  cached = null;
  runtimePaseoHome = null;
}
