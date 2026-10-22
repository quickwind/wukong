import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACPAgentClient } from "../server/agent/providers/acp-agent.js";
import { ClaudeAgentClient } from "../server/agent/providers/claude/agent.js";
import { hasRunningClaudeBackgroundShell } from "./idle-release-busy.js";
import {
  rawSessionFor,
  registerRawSession,
  resetIdleReleaseSessionsForTests,
} from "./idle-release-sessions.js";
import { resetIdleReleaseSettingsForTests } from "./idle-release-settings.js";
import { activateIrixPolicy } from "./policy.js";
import {
  attachIrixAgentManager,
  attachIrixWsServer,
  isSubagentApprovalRequired,
  resetSubagentApprovalCacheForTests,
  setIdleReleaseWiringDepsForTests,
  setSubagentApprovalRequired,
} from "./subagent-approval.js";

type Method = (...args: unknown[]) => Promise<unknown>;
type Proto = Record<"createSession" | "resumeSession", Method>;
const claudeProto = ClaudeAgentClient.prototype as unknown as Proto;
const acpProto = ACPAgentClient.prototype as unknown as Proto;
const realMethods = {
  claudeCreate: claudeProto.createSession,
  claudeResume: claudeProto.resumeSession,
  acpCreate: acpProto.createSession,
  acpResume: acpProto.resumeSession,
};

function restorePrototypes(): void {
  claudeProto.createSession = realMethods.claudeCreate;
  claudeProto.resumeSession = realMethods.claudeResume;
  acpProto.createSession = realMethods.acpCreate;
  acpProto.resumeSession = realMethods.acpResume;
}

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-22T12:00:00.000Z");

function fakeAgent(id: string, provider = "devin") {
  return {
    id,
    provider,
    lifecycle: "idle",
    activeForegroundTurnId: null,
    pendingPermissions: new Map(),
    internal: false,
    updatedAt: new Date(NOW - 30 * MINUTE),
    config: { provider },
  };
}

function fakeManager(agents: ReturnType<typeof fakeAgent>[] = [], extra: object = {}) {
  return {
    agents: new Map(agents.map((a) => [a.id, a])),
    clients: new Map<string, unknown>(),
    respondToPermission: vi.fn(async () => undefined),
    listAgents: () => agents,
    closeAgent: vi.fn(async (_id: string) => undefined),
    ...extra,
  };
}

describe("idle release wiring", () => {
  let deactivate: () => void;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    deactivate = activateIrixPolicy();
    home = mkdtempSync(path.join(tmpdir(), "idle-wiring-"));
    previousHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = home;
    resetIdleReleaseSettingsForTests();
    resetSubagentApprovalCacheForTests(null);
  });

  afterEach(() => {
    restorePrototypes();
    resetIdleReleaseSessionsForTests();
    setIdleReleaseWiringDepsForTests(null);
    deactivate();
    vi.useRealTimers();
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    resetIdleReleaseSettingsForTests();
    rmSync(home, { recursive: true, force: true });
  });

  it("starts exactly one sweep per manager however often it is attached", () => {
    const manager = fakeManager();
    attachIrixAgentManager(manager);
    attachIrixAgentManager(manager);
    expect(vi.getTimerCount()).toBe(1);
  });

  // The manager's clients come from the provider registry and hand out a facade, so the hook
  // sits on the client classes, whatever client object the manager holds.
  it("attaching the manager hooks the Claude and ACP client prototypes", async () => {
    const raw = { translateMessageToEvents: () => [] };
    const translate = raw.translateMessageToEvents;
    claudeProto.createSession = async () => raw;
    const stub = claudeProto.createSession;
    attachIrixAgentManager(fakeManager());
    expect(claudeProto.createSession).not.toBe(stub);
    expect(acpProto.createSession).not.toBe(realMethods.acpCreate);

    // A client created after attaching (upstream replaces clients on a providers config change).
    const client = Object.create(ClaudeAgentClient.prototype) as typeof claudeProto;
    const session = await client.createSession({}, { agentId: "late" });
    expect(session).toBe(raw);
    expect(rawSessionFor("late")).toBe(raw);
    expect(raw.translateMessageToEvents).not.toBe(translate);
    // Tracked with no shell: releasable. An untracked session would count as busy.
    expect(hasRunningClaudeBackgroundShell(raw)).toBe(false);
  });

  it("attaching the ws server hooks the client prototypes", () => {
    attachIrixWsServer({ paseoHome: home });
    expect(claudeProto.resumeSession).not.toBe(realMethods.claudeResume);
    expect(acpProto.resumeSession).not.toBe(realMethods.acpResume);
  });

  it("config broadcasts triggered by another setting still carry idleRelease and approval", () => {
    const listeners: ((config: Record<string, unknown>) => void)[] = [];
    const storeConfig: Record<string, unknown> = { base: 1 };
    const store = {
      get: (): Record<string, unknown> => ({ ...storeConfig }),
      patch: (p: Record<string, unknown>): Record<string, unknown> => {
        Object.assign(storeConfig, p);
        for (const listener of listeners) listener({ ...storeConfig });
        return { ...storeConfig };
      },
    };
    const sent: Record<string, unknown>[] = [];
    // Mirrors upstream: onChange calls the private broadcast through `this`.
    class FakeWsServer {
      paseoHome = home;
      daemonConfigStore = store;
      constructor() {
        listeners.push((config) => this.broadcastDaemonConfigChanged(config));
      }
      broadcastDaemonConfigChanged(config: Record<string, unknown>): void {
        sent.push(config);
      }
    }
    const wsServer = new FakeWsServer();
    attachIrixWsServer(wsServer);
    store.patch({ idleRelease: { minutes: 7 } });
    sent.length = 0;

    store.patch({ other: 2 });
    expect(sent.length).toBeGreaterThan(0);
    for (const config of sent) {
      expect(config).toMatchObject({
        other: 2,
        requireSubagentApproval: true,
        idleRelease: { enabled: true, minutes: 7 },
      });
    }
  });

  it("reads and saves the approval setting from a daemon.json with a UTF-8 BOM", () => {
    const file = path.join(home, "daemon.json");
    writeFileSync(
      file,
      `\uFEFF${JSON.stringify({ other: 1, daemon: { keep: true, requireSubagentApproval: false } })}`,
      "utf8",
    );
    vi.stubEnv("IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL", "1");
    try {
      // Point the approval reader at this test's home (it keeps the last ws server's home).
      attachIrixWsServer({ paseoHome: home });
      expect(isSubagentApprovalRequired()).toBe(false);
      setSubagentApprovalRequired(true);
      const raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      expect(raw.other).toBe(1);
      expect(raw.daemon.keep).toBe(true);
      expect(raw.daemon.requireSubagentApproval).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("composes the config store wrappers on attachIrixWsServer", () => {
    const store = {
      get: (): Record<string, unknown> => ({ base: 1 }),
      patch: (p: Record<string, unknown>): Record<string, unknown> => ({ base: 1, ...p }),
    };
    attachIrixWsServer({ paseoHome: home, daemonConfigStore: store });
    expect(store.get()).toMatchObject({
      base: 1,
      requireSubagentApproval: true,
      idleRelease: { enabled: true, minutes: 15 },
    });
    const merged = store.patch({ idleRelease: { minutes: 5 } });
    expect(merged).toMatchObject({
      requireSubagentApproval: true,
      idleRelease: { enabled: true, minutes: 5 },
    });
  });

  it("the started sweep passes isBusy, viewed and a logger: releases only the releasable agent", async () => {
    const releasable = fakeAgent("releasable");
    const busy = fakeAgent("busy");
    const viewedAgent = fakeAgent("viewed");
    const warn = vi.fn();
    const info = vi.fn();
    const manager = fakeManager([releasable, busy, viewedAgent], {
      listProviderSubagents: (id: string) => (id === "busy" ? [{ status: "running" }] : []),
      logger: { info, warn },
    });
    setIdleReleaseWiringDepsForTests({
      now: () => NOW,
      intervalMs: 10,
      viewed: () => new Set(["viewed"]),
    });
    for (const id of ["releasable", "busy", "viewed"]) {
      registerRawSession(id, { terminalEntries: new Map() });
    }
    const close = manager.closeAgent;
    attachIrixAgentManager(manager);
    // Two ticks: the first records candidates, the second closes them.
    await vi.advanceTimersByTimeAsync(25);
    expect(close.mock.calls.map((c) => c[0])).toEqual(["releasable"]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "releasable" }),
      "irix.idle_release.released",
    );
  });

  it("uses the real viewers module once the ws server is attached", async () => {
    const target = fakeAgent("focused");
    const manager = fakeManager([target]);
    const ws = {};
    const wsServer = {
      paseoHome: home,
      agentManager: manager,
      sessions: new Map([
        [
          ws,
          {
            session: {
              getClientActivity: () => ({
                appVisible: true,
                focusedAgentId: "focused",
                lastActivityAt: new Date(NOW),
              }),
            },
          },
        ],
      ]),
    };
    setIdleReleaseWiringDepsForTests({ now: () => NOW, intervalMs: 10 });
    const close = manager.closeAgent;
    attachIrixWsServer(wsServer);
    await vi.advanceTimersByTimeAsync(25);
    expect(close).not.toHaveBeenCalled();
  });

  it("leaves the config store untouched when the Irix policy is off", () => {
    deactivate();
    const store = {
      get: (): Record<string, unknown> => ({ base: 1 }),
      patch: (p: Record<string, unknown>): Record<string, unknown> => ({ base: 1, ...p }),
    };
    attachIrixWsServer({ paseoHome: home, daemonConfigStore: store });
    expect(store.get()).not.toHaveProperty("idleRelease");
    // Passed through to the original store untouched (not validated, not persisted by us).
    expect(store.patch({ idleRelease: { minutes: 0 } })).toMatchObject({
      idleRelease: { minutes: 0 },
    });
    expect(existsSync(path.join(home, "daemon.json"))).toBe(false);
  });

  it("leaves the client prototypes untouched when the Irix policy is off", () => {
    deactivate();
    attachIrixAgentManager(fakeManager());
    attachIrixWsServer({ paseoHome: home });
    expect(claudeProto.createSession).toBe(realMethods.claudeCreate);
    expect(claudeProto.resumeSession).toBe(realMethods.claudeResume);
    expect(acpProto.createSession).toBe(realMethods.acpCreate);
    expect(acpProto.resumeSession).toBe(realMethods.acpResume);
  });
});
