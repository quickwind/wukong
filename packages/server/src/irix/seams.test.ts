// Seam tests: each Irix hook on an upstream member runs against the real upstream object (a real
// DaemonConfigStore, a real ClaudeAgentClient, real prototypes), never a fake shaped like it.
// A failure here means upstream changed something under an Irix hook; read the hook first.
// See irix/docs/test-plan.md (layer 1).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentPersistenceHandle,
  AgentSessionConfig,
} from "../server/agent/agent-sdk-types.js";
import { AgentManager } from "../server/agent/agent-manager.js";
import {
  createIdleRuntimeCleanup,
  type RuntimeCleanupCandidate,
} from "../server/agent/idle-runtime-cleanup/index.js";
import { ClaudeAgentClient } from "../server/agent/providers/claude/agent.js";
import { DaemonConfigStore } from "../server/daemon-config-store.js";
import { loadPersistedConfig } from "../server/persisted-config.js";
import { Session } from "../server/session.js";
import { VoiceAssistantWebSocketServer } from "../server/websocket-server.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { installClaudeAgentGuide, resetClaudeAgentGuideForTests } from "./claude-agent-guide.js";
import { installClaudeSessionGate, resetClaudeSessionGateForTests } from "./claude-session-gate.js";
import { resetIrixApprovalHostForTests } from "./create-approval.js";
import { attachIdleViewers, isIrixAgentViewed } from "./idle-viewers.js";
import { activateIrixPolicy } from "./policy.js";
import {
  getAgentToolsChannel,
  resetAgentToolsForTests,
  wrapAgentToolsConfigStore,
} from "./agent-tools-setting.js";
import { attachIrixWsServer, resetSubagentApprovalCacheForTests } from "./subagent-approval.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = (...parts: string[]) => path.join(here, "..", "server", ...parts);
const NOW = Date.parse("2026-10-22T12:00:00Z");
const MIN = 60_000;

const IRIX_VARIABLES = [
  "IRIX_UNRESTRICTED",
  "IRIX_ALLOW_AGENT_TOOLS",
  "IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL",
  "IRIX_IDLE_MINUTES",
] as const;

// The same shape daemon-config-store.test.ts uses to build a store.
const INITIAL_CONFIG = {
  relay: { enabled: false },
  mcp: { injectIntoAgents: false },
  browserTools: { enabled: false },
  providers: {},
  metadataGeneration: { providers: [] },
  autoArchiveAfterMerge: false,
  enableTerminalAgentHooks: false,
  appendSystemPrompt: "",
};

const realCreateSession = ClaudeAgentClient.prototype.createSession;
const realResumeSession = ClaudeAgentClient.prototype.resumeSession;

const tempDirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "irix-seams-"));
  tempDirs.push(dir);
  return dir;
}

function makeStore(paseoHome: string): DaemonConfigStore {
  return new DaemonConfigStore(paseoHome, INITIAL_CONFIG, createTestLogger());
}

/**
 * A ws server built on the real class prototype with only the instance state Irix reads. The
 * broadcasts are replaced because the real ones need a live socket set.
 */
function wsServerOn(paseoHome: string, store: DaemonConfigStore) {
  // The Irix wrapper replaces broadcastDaemonConfigChanged with its own function, so the spies
  // are kept separately for assertions.
  const spies = {
    broadcastCapabilitiesUpdate: vi.fn(),
    broadcastDaemonConfigChanged: vi.fn(),
  };
  const wsServer = Object.create(VoiceAssistantWebSocketServer.prototype) as Record<
    string,
    unknown
  >;
  Object.assign(wsServer, { paseoHome, daemonConfigStore: store, ...spies });
  return { wsServer, spies };
}

/** A ws server whose one socket has `activity` recorded on a real Session. */
function wsServerWithActivity(ws: object, activity: Record<string, unknown> | null) {
  const session = Object.assign(Object.create(Session.prototype) as object, {
    clientSources: new Map([[ws, { activity }]]),
  });
  return Object.assign(Object.create(VoiceAssistantWebSocketServer.prototype) as object, {
    sessions: new Map([[ws, { session }]]),
  });
}

function activityFor(agentId: string, lastActivityAt: number) {
  return {
    deviceType: "web",
    focusedAgentId: agentId,
    focusedTerminalId: null,
    lastActivityAt: new Date(lastActivityAt),
    appVisible: true,
    appVisibilityChangedAt: new Date(lastActivityAt),
  };
}

function runtimeCandidate(agentId: string, lastActivityAt: number, onClose: () => void) {
  const identity = {};
  const candidate: RuntimeCleanupCandidate = {
    identity,
    agentId,
    parentAgentId: undefined,
    provider: "claude",
    sessionId: `session-${agentId}`,
    lastActivityAt,
    isEligible: () => true,
    closeIfEligible: async (revalidate) => {
      if (!revalidate()) return false;
      onClose();
      return true;
    },
  };
  return candidate;
}

function claudeClient() {
  return new ClaudeAgentClient({ logger: createTestLogger() });
}

function claudeConfig(cwd: string): AgentSessionConfig {
  return { provider: "claude", cwd } as AgentSessionConfig;
}

function sourceOf(...parts: string[]): string {
  return readFileSync(serverSrc(...parts), "utf8");
}

beforeEach(() => {
  for (const name of IRIX_VARIABLES) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  ClaudeAgentClient.prototype.createSession = realCreateSession;
  ClaudeAgentClient.prototype.resumeSession = realResumeSession;
  resetClaudeSessionGateForTests();
  resetClaudeAgentGuideForTests();
  resetAgentToolsForTests();
  resetSubagentApprovalCacheForTests(null);
  resetIrixApprovalHostForTests();
  attachIdleViewers(undefined);
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("seam 1: DaemonConfigStore under the Irix store wrappers", () => {
  let deactivate: () => void;

  beforeEach(() => {
    deactivate = activateIrixPolicy();
  });

  afterEach(() => {
    deactivate();
  });

  it("store.patch returns a Promise through the Irix wrappers", async () => {
    const home = tempHome();
    const store = makeStore(home);
    attachIrixWsServer(wsServerOn(home, store).wsServer);
    const pending = store.patch({ idleRuntimeCleanup: false });
    expect(pending).toBeInstanceOf(Promise);
    await pending;
  });

  it("idleRuntimeCleanup resolves to the new value, reads back, and persists", async () => {
    const home = tempHome();
    const store = makeStore(home);
    attachIrixWsServer(wsServerOn(home, store).wsServer);

    const patched = await store.patch({ idleRuntimeCleanup: false });

    expect(patched.idleRuntimeCleanup).toBe(false);
    expect(store.get().idleRuntimeCleanup).toBe(false);
    expect(loadPersistedConfig(home).agents?.idleRuntimeCleanup).toBe(false);
  });

  it("get() stays synchronous and reports the Irix approval and tool fields", () => {
    const home = tempHome();
    const store = makeStore(home);
    attachIrixWsServer(wsServerOn(home, store).wsServer);

    const config = store.get();

    expect(config).not.toBeInstanceOf(Promise);
    expect(config).toMatchObject({
      agentTools: "cli",
      agentToolsEditable: false,
      requireSubagentApproval: true,
      subagentApprovalLocked: true,
    });
    // In "cli" the agent manager is told Paseo's MCP tools are off for both Irix providers.
    expect(config.providers).toMatchObject({
      claude: { paseoTools: { enabled: false } },
      devin: { paseoTools: { enabled: false } },
    });
  });

  it("agentTools round-trips through patch, get, daemon.json and the broadcast when unlocked", async () => {
    vi.stubEnv("IRIX_ALLOW_AGENT_TOOLS", "1");
    const home = tempHome();
    const store = makeStore(home);
    const { wsServer, spies } = wsServerOn(home, store);
    attachIrixWsServer(wsServer);

    const patched = await store.patch({ agentTools: "mcp" });

    expect(patched).toMatchObject({ agentTools: "mcp", agentToolsEditable: true });
    expect(store.get().agentTools).toBe("mcp");
    expect(getAgentToolsChannel()).toBe("mcp");
    const onDisk = JSON.parse(readFileSync(path.join(home, "daemon.json"), "utf8"));
    expect(onDisk.daemon.agentTools).toBe("mcp");
    expect(spies.broadcastDaemonConfigChanged).toHaveBeenCalledWith(
      expect.objectContaining({ agentTools: "mcp" }),
    );
  });

  it("agentTools is refused while the setting is locked, and the channel stays cli", async () => {
    const home = tempHome();
    const store = makeStore(home);
    attachIrixWsServer(wsServerOn(home, store).wsServer);

    await expect(store.patch({ agentTools: "mcp" })).rejects.toThrow("fixed on this daemon");
    expect(store.get().agentTools).toBe("cli");
  });

  it("wrapAgentToolsConfigStore alone awaits the upstream patch and merges the agent-tools fields", async () => {
    vi.stubEnv("IRIX_ALLOW_AGENT_TOOLS", "1");
    const home = tempHome();
    const store = makeStore(home);
    wrapAgentToolsConfigStore(wsServerOn(home, store).wsServer);

    const merged = await store.patch({ agentTools: "mcp", idleRuntimeCleanup: false });

    expect(merged).toMatchObject({ agentTools: "mcp", idleRuntimeCleanup: false });
    expect(store.get()).toMatchObject({ agentTools: "mcp", idleRuntimeCleanup: false });
  });

  it("requireSubagentApproval round-trips when the control is unlocked", async () => {
    vi.stubEnv("IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL", "1");
    const home = tempHome();
    const store = makeStore(home);
    const { wsServer, spies } = wsServerOn(home, store);
    attachIrixWsServer(wsServer);

    const patched = await store.patch({ requireSubagentApproval: false });

    expect(patched).toMatchObject({
      requireSubagentApproval: false,
      subagentApprovalLocked: false,
    });
    expect(store.get().requireSubagentApproval).toBe(false);
    expect(spies.broadcastDaemonConfigChanged).toHaveBeenCalledWith(
      expect.objectContaining({ requireSubagentApproval: false }),
    );
  });

  it("requireSubagentApproval cannot be turned off while locked", async () => {
    const home = tempHome();
    const store = makeStore(home);
    attachIrixWsServer(wsServerOn(home, store).wsServer);

    await expect(store.patch({ requireSubagentApproval: false })).rejects.toThrow();
    expect(store.get().requireSubagentApproval).toBe(true);
  });
});

describe("seam 2: ClaudeAgentClient createSession and resumeSession", () => {
  let deactivate: () => void;

  beforeEach(() => {
    deactivate = activateIrixPolicy();
  });

  afterEach(() => {
    deactivate();
  });

  it("both are async functions on the real prototype, and the gate replaces them", () => {
    expect(typeof realCreateSession).toBe("function");
    expect(typeof realResumeSession).toBe("function");
    installClaudeSessionGate();
    expect(typeof ClaudeAgentClient.prototype.createSession).toBe("function");
    expect(typeof ClaudeAgentClient.prototype.resumeSession).toBe("function");
    expect(ClaudeAgentClient.prototype.createSession).not.toBe(realCreateSession);
    expect(ClaudeAgentClient.prototype.resumeSession).not.toBe(realResumeSession);
  });

  it("createSession takes the config first and the launch context second", async () => {
    const dir = tempHome();
    const session = await claudeClient().createSession(claudeConfig(dir), {
      agentId: "seam-agent",
    });
    const internals = session as unknown as { config: { cwd: string }; agentId?: string };
    expect(internals.config.cwd).toBe(dir);
    expect(internals.agentId).toBe("seam-agent");
  });

  it("resumeSession takes the persistence handle first, its overrides second, the launch context third", async () => {
    const dir = tempHome();
    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "claude-session-1",
      metadata: { cwd: dir },
    };
    const session = await claudeClient().resumeSession(handle, undefined, {
      agentId: "seam-agent",
    });
    const internals = session as unknown as {
      config: { cwd: string };
      claudeSessionId: string | null;
      agentId?: string;
    };
    expect(internals.config.cwd).toBe(dir);
    expect(internals.claudeSessionId).toBe("claude-session-1");
    expect(internals.agentId).toBe("seam-agent");
  });

  it("the gate puts the subagent ask hook on a real created session", async () => {
    installClaudeSessionGate();
    const session = await claudeClient().createSession(claudeConfig(tempHome()));
    expect(Object.hasOwn(session, "buildSubagentEffortHooks")).toBe(true);
    const hooks = (
      session as unknown as { buildSubagentEffortHooks(): unknown }
    ).buildSubagentEffortHooks() as { PreToolUse: Array<{ matcher?: string }> };
    expect(hooks.PreToolUse[0]?.matcher).toBe("Task|Agent");
  });

  it("the gate puts the subagent ask hook on a real resumed session", async () => {
    installClaudeSessionGate();
    const session = await claudeClient().resumeSession(
      { provider: "claude", sessionId: "claude-session-2", metadata: { cwd: tempHome() } },
      undefined,
      { agentId: "seam-agent" },
    );
    const hooks = (
      session as unknown as { buildSubagentEffortHooks(): unknown }
    ).buildSubagentEffortHooks() as { PreToolUse: Array<{ matcher?: string }> };
    expect(hooks.PreToolUse[0]?.matcher).toBe("Task|Agent");
  });

  it("the gate leaves real sessions alone when the Irix policy is off", async () => {
    deactivate();
    installClaudeSessionGate();
    expect(ClaudeAgentClient.prototype.createSession).toBe(realCreateSession);
    const session = await claudeClient().createSession(claudeConfig(tempHome()));
    expect(Object.hasOwn(session, "buildSubagentEffortHooks")).toBe(false);
  });

  it("the agent guide hook reads the agent id from createSession's second argument", async () => {
    installClaudeAgentGuide();
    const session = await claudeClient().createSession(claudeConfig(tempHome()), {
      agentId: "guided-agent",
    });
    const internals = session as unknown as {
      agentId?: string;
      config: { daemonAppendSystemPrompt?: unknown };
    };
    expect(internals.agentId).toBe("guided-agent");
    // The guide is added to the config the session keeps (default channel: command line).
    expect(typeof internals.config.daemonAppendSystemPrompt).toBe("string");
  });
});

describe("seam 3: upstream idle collector with Irix's viewed-agent check", () => {
  let deactivate: () => void;
  let closed: string[];
  let now: number;

  beforeEach(() => {
    deactivate = activateIrixPolicy();
    closed = [];
    now = NOW;
  });

  afterEach(() => {
    deactivate();
  });

  function collectorWith(agentId: string, lastActivityAt: number) {
    const runtime = runtimeCandidate(agentId, lastActivityAt, () => closed.push(agentId));
    return createIdleRuntimeCleanup({
      enabled: true,
      logger: createTestLogger(),
      now: () => now,
      runtimes: () => [runtime],
      isProtected: (viewedId) => isIrixAgentViewed(viewedId, now),
      schedule: () => () => {},
    });
  }

  it("keeps a runtime idle past IRIX_IDLE_MINUTES while a person has its agent open", async () => {
    vi.stubEnv("IRIX_IDLE_MINUTES", "30");
    attachIdleViewers(wsServerWithActivity({}, activityFor("agent-1", NOW - MIN)));
    const cleanup = collectorWith("agent-1", NOW - 31 * MIN);

    await cleanup.sweep();
    await cleanup.close();

    expect(closed).toEqual([]);
  });

  it("closes the same idle runtime when nobody has its agent open", async () => {
    vi.stubEnv("IRIX_IDLE_MINUTES", "30");
    attachIdleViewers(wsServerWithActivity({}, activityFor("agent-2", NOW - MIN)));
    const cleanup = collectorWith("agent-1", NOW - 31 * MIN);

    await cleanup.sweep();
    await cleanup.close();

    expect(closed).toEqual(["agent-1"]);
  });

  it("restarts the idle clock when the viewer goes away", async () => {
    vi.stubEnv("IRIX_IDLE_MINUTES", "30");
    const ws = {};
    attachIdleViewers(wsServerWithActivity(ws, activityFor("agent-1", NOW - MIN)));
    const cleanup = collectorWith("agent-1", NOW - 31 * MIN);

    await cleanup.sweep();
    expect(closed).toEqual([]);

    attachIdleViewers(undefined);
    now = NOW + MIN;
    await cleanup.sweep();
    expect(closed).toEqual([]);

    now = NOW + 31 * MIN;
    await cleanup.sweep();
    await cleanup.close();
    expect(closed).toEqual(["agent-1"]);
  });

  it("upstream's one-hour period still applies with Irix off", async () => {
    deactivate();
    vi.stubEnv("IRIX_IDLE_MINUTES", "30");
    const cleanup = collectorWith("agent-1", NOW - 31 * MIN);

    await cleanup.sweep();
    await cleanup.close();

    expect(closed).toEqual([]);
  });
});

describe("seam 4: ws server internals read by idle-viewers.ts", () => {
  it("the ws server keeps its sessions by socket, each entry holding a Session", () => {
    const source = sourceOf("websocket-server.ts");
    expect(source).toContain("class VoiceAssistantWebSocketServer");
    expect(source).toContain("private readonly sessions: Map<WebSocketLike, SessionConnection>");
    expect(source).toMatch(/interface SessionConnectionBase \{[\s\S]*?\n\s+session: Session;/);
    expect(source).toContain("for (const [ws, connection] of this.sessions)");
  });

  it("the session records activity under the socket it came from, which is the key the accessor takes", () => {
    const wsSource = sourceOf("websocket-server.ts");
    expect(wsSource).toContain("updateClientCapabilities(clientCapabilities, ws");
    expect(wsSource).toContain("session.handleMessage(message.message, ws)");
    expect(sourceOf("session.ts")).toContain("private readonly clientSources = new Map<");
  });

  it("Session.prototype.getClientActivity is a function and returns the activity recorded for the given socket", () => {
    expect(typeof Session.prototype.getClientActivity).toBe("function");
    const ws = {};
    const other = {};
    const activity = activityFor("agent-1", NOW);
    const session = Object.assign(Object.create(Session.prototype) as Session, {
      clientSources: new Map([[ws, { activity }]]),
    });
    expect(session.getClientActivity(ws)).toBe(activity);
    expect(session.getClientActivity(other)).toBeNull();
  });
});

describe("seam 5: other private upstream members Irix reads by name", () => {
  it("AgentManager keeps the fields the subagent gate, create-approval and the agent guide read", () => {
    const source = sourceOf("agent", "agent-manager.ts");
    expect(source).toMatch(/private readonly agents = new Map</);
    expect(source).toMatch(/private readonly clients = new Map</);
    expect(source).toMatch(/private readonly paseoToolPolicies = new Map</);
    expect(source).toMatch(/private (readonly )?mcpBaseUrl: string \| null;/);
    expect(source).toMatch(/private readonly mcpAuthToken: string \| null;/);
    expect(source).toMatch(/pendingPermissions: Map<string, AgentPermissionRequest>;/);
  });

  it("AgentManager.prototype has the methods the subagent gate calls", () => {
    expect(typeof AgentManager.prototype.respondToPermission).toBe("function");
    expect(typeof AgentManager.prototype.closeAgent).toBe("function");
    expect(typeof AgentManager.prototype.notifyAgentState).toBe("function");
  });

  it("AgentManager.prototype.cancelAgentRun exists: the Irix subagent gate wraps it on interrupt", () => {
    // Session.interruptAgentIfRunning calls cancelAgentRun; the Irix wrapper cancels the parent's
    // pending synthetic approvals there. The old hook sat on `interruptAgent`, which upstream does
    // not have, so it was never installed.
    expect(typeof AgentManager.prototype.cancelAgentRun).toBe("function");
    expect((AgentManager.prototype as { interruptAgent?: unknown }).interruptAgent).toBeUndefined();
  });

  it("AgentManager has no public emit: cards reach the app through pendingPermissions and notifyAgentState", () => {
    expect((AgentManager.prototype as { emit?: unknown }).emit).toBeUndefined();
  });

  it("a real Claude session has the members the subagent gate patches", async () => {
    const session = (await claudeClient().createSession(
      claudeConfig(tempHome()),
    )) as unknown as Record<string, unknown>;
    expect(typeof session.buildSubagentEffortHooks).toBe("function");
    expect(typeof session.pushEvent).toBe("function");
    expect(typeof session.handlePermissionRequest).toBe("function");
    expect((session.config as { cwd?: unknown }).cwd).toBeTypeOf("string");
  });

  it("the Claude client map is keyed by provider id, which subagent-approval reads with 'claude'", () => {
    const source = sourceOf("agent", "agent-manager.ts");
    expect(source).toMatch(/private readonly clients = new Map<AgentProvider, AgentClient>\(\)/);
    expect(claudeClient().provider).toBe("claude");
  });

  it("the ACP session keeps the connection Devin's first-prompt injection reads", () => {
    const source = sourceOf("agent", "providers", "acp-agent.ts");
    expect(source).toMatch(/private connection: ClientSideConnection \| null = null;/);
  });

  it("the agent session config carries daemonAppendSystemPrompt, which the resume path reads from metadata", () => {
    const source = sourceOf("agent", "agent-sdk-types.ts");
    expect(source).toMatch(/daemonAppendSystemPrompt\?: string;/);
  });

  it("the ws server has the fields and broadcasts attachIrixWsServer and the store listener use", () => {
    const source = sourceOf("websocket-server.ts");
    expect(source).toMatch(/private readonly paseoHome: string;/);
    expect(source).toMatch(/private readonly daemonConfigStore: DaemonConfigStore;/);
    expect(source).toMatch(/private readonly agentManager: AgentManager;/);
    expect(source).toContain("private broadcastCapabilitiesUpdate(): void");
    expect(source).toContain(
      "private broadcastDaemonConfigChanged(config: MutableDaemonConfig): void",
    );
    // The store listener calls through `this`, so an instance property shadows the method.
    expect(source).toContain("this.broadcastDaemonConfigChanged(config);");
    expect(typeof VoiceAssistantWebSocketServer.prototype).toBe("object");
  });
});
