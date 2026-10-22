import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hasRunningClaudeBackgroundShell } from "./idle-release-busy.js";
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

  it("wraps translateMessageToEvents on Claude sessions from both factories", async () => {
    const translate = () => [];
    const claude = {
      createSession: async () => ({ translateMessageToEvents: translate }),
      resumeSession: async () => ({ translateMessageToEvents: translate }),
    };
    const manager = fakeManager();
    manager.clients.set("claude", claude);
    attachIrixAgentManager(manager);
    const created = (await claude.createSession()) as { translateMessageToEvents: unknown };
    const resumed = (await claude.resumeSession()) as { translateMessageToEvents: unknown };
    expect(created.translateMessageToEvents).not.toBe(translate);
    expect(resumed.translateMessageToEvents).not.toBe(translate);
  });

  it("wraps a Claude client that replaced the original after the manager was attached", async () => {
    const translate = () => [];
    const first = { createSession: async () => ({ translateMessageToEvents: translate }) };
    const manager = fakeManager();
    manager.clients.set("claude", first);
    attachIrixAgentManager(manager);

    // Upstream updateProviderRegistry installs a new client object on a providers config change.
    const replacement = { createSession: async () => ({ translateMessageToEvents: translate }) };
    manager.clients.set("claude", replacement);
    attachIrixAgentManager(manager);

    const session = (await replacement.createSession()) as { translateMessageToEvents: unknown };
    expect(session.translateMessageToEvents).not.toBe(translate);
    // Tracked with no shell: releasable. An untracked session would count as busy.
    expect(hasRunningClaudeBackgroundShell(session)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
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

  it("keeps the original translateMessageToEvents when the Irix policy is off", async () => {
    deactivate();
    const translate = () => [];
    const claude = { createSession: async () => ({ translateMessageToEvents: translate }) };
    const manager = fakeManager();
    manager.clients.set("claude", claude);
    attachIrixAgentManager(manager);
    const session = (await claude.createSession()) as { translateMessageToEvents: unknown };
    expect(session.translateMessageToEvents).toBe(translate);
  });
});
