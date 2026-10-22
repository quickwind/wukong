import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { AgentManager } from "../server/agent/agent-manager.js";
import { ensureAgentLoaded } from "../server/agent/agent-loading.js";
import { startAgentRun } from "../server/agent/agent-prompt.js";
import { AgentStorage } from "../server/agent/agent-storage.js";
import { createTestAgentClients } from "../server/test-utils/fake-agent-client.js";
import { activateIrixPolicy } from "./policy.js";
import {
  DEFAULT_IDLE_RELEASE,
  resetIdleReleaseSettingsForTests,
  setIdleReleaseSettings,
} from "./idle-release-settings.js";
import {
  type IdleReleaseManager,
  type IdleReleaseSweepState,
  type ManagedAgentLike,
  isReleasable,
  startIdleRelease,
  sweepOnce,
} from "./idle-release.js";

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-22T12:00:00.000Z");

function agent(overrides: Partial<ManagedAgentLike> = {}): ManagedAgentLike {
  return {
    id: "agent-1",
    provider: "devin",
    lifecycle: "idle",
    activeForegroundTurnId: null,
    pendingPermissions: { size: 0 },
    internal: false,
    updatedAt: new Date(NOW - 15 * MINUTE),
    ...overrides,
  };
}

function ctx(
  overrides: Partial<Parameters<typeof isReleasable>[1]> = {},
): Parameters<typeof isReleasable>[1] {
  return {
    now: NOW,
    settings: { ...DEFAULT_IDLE_RELEASE },
    viewed: new Set<string>(),
    busy: false,
    ...overrides,
  };
}

describe("isReleasable", () => {
  test("releases an idle devin agent idle for 15 minutes", () => {
    expect(isReleasable(agent(), ctx())).toBe(true);
  });

  test("does not release at 14:59", () => {
    expect(isReleasable(agent({ updatedAt: new Date(NOW - 15 * MINUTE + 1000) }), ctx())).toBe(
      false,
    );
  });

  test("does not release when disabled", () => {
    expect(isReleasable(agent(), ctx({ settings: { enabled: false, minutes: 15 } }))).toBe(false);
  });

  test.each(["running", "initializing", "error", "closed"] as const)(
    "does not release a %s agent",
    (lifecycle) => {
      expect(isReleasable(agent({ lifecycle }), ctx())).toBe(false);
    },
  );

  test("does not release with an active foreground turn", () => {
    expect(isReleasable(agent({ activeForegroundTurnId: "turn-1" }), ctx())).toBe(false);
  });

  test("does not release with a pending permission", () => {
    expect(isReleasable(agent({ pendingPermissions: { size: 1 } }), ctx())).toBe(false);
  });

  test("does not release an internal agent", () => {
    expect(isReleasable(agent({ internal: true }), ctx())).toBe(false);
  });

  test("does not release an opencode agent", () => {
    expect(isReleasable(agent({ provider: "opencode" }), ctx())).toBe(false);
  });

  test("does not release a viewed agent", () => {
    expect(isReleasable(agent(), ctx({ viewed: new Set(["agent-1"]) }))).toBe(false);
  });

  test("does not release a busy agent", () => {
    expect(isReleasable(agent(), ctx({ busy: true }))).toBe(false);
  });
});

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function newState(): IdleReleaseSweepState {
  return { candidates: new Map() };
}

function closedIds(manager: IdleReleaseManager): string[] {
  return vi.mocked(manager.closeAgent).mock.calls.map(([id]) => id);
}

function fakeManager(agents: ManagedAgentLike[], closeAgent: (id: string) => Promise<void>) {
  const live = new Map(agents.map((entry) => [entry.id, entry]));
  const manager: IdleReleaseManager = {
    listAgents: () => Array.from(live.values()),
    closeAgent: vi.fn(async (id: string) => {
      await closeAgent(id);
      live.delete(id);
    }),
  };
  return manager;
}

describe("sweep", () => {
  let deactivate: (() => void) | null = null;

  beforeEach(() => {
    resetIdleReleaseSettingsForTests();
    vi.stubEnv("PASEO_HOME", "");
  });

  afterEach(() => {
    deactivate?.();
    deactivate = null;
    vi.unstubAllEnvs();
    vi.useRealTimers();
    resetIdleReleaseSettingsForTests();
  });

  test("sweep closes only agents releasable on two ticks in a row and logs each release", async () => {
    deactivate = activateIrixPolicy();
    const logger = fakeLogger();
    const manager = fakeManager(
      [
        agent({ id: "old-devin", provider: "devin", updatedAt: new Date(NOW - 20 * MINUTE) }),
        agent({ id: "old-claude", provider: "claude", updatedAt: new Date(NOW - 16 * MINUTE) }),
        agent({ id: "fresh", updatedAt: new Date(NOW - 5 * MINUTE) }),
        agent({ id: "viewed" }),
        agent({ id: "busy" }),
        agent({ id: "codex", provider: "codex" }),
      ],
      async () => undefined,
    );
    const deps = {
      now: () => NOW,
      viewed: () => new Set(["viewed"]),
      isBusy: (entry: ManagedAgentLike) => entry.id === "busy",
      logger,
    };
    const state = newState();

    await sweepOnce(manager, deps, state);
    expect(manager.closeAgent).not.toHaveBeenCalled();
    expect([...state.candidates.keys()]).toEqual(["old-devin", "old-claude"]);

    await sweepOnce(manager, deps, state);
    expect(closedIds(manager)).toEqual(["old-devin", "old-claude"]);
    expect(logger.info.mock.calls.map(([fields]) => fields)).toEqual([
      { agentId: "old-devin", provider: "devin", idleMinutes: 20 },
      { agentId: "old-claude", provider: "claude", idleMinutes: 16 },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(state.candidates.size).toBe(0);
  });

  // An unresolved session counts as busy and warns, so probing every agent (closed, codex, in a
  // turn) would warn about agents the sweep would never release anyway.
  test("probes busy only for agents that pass every other check", async () => {
    deactivate = activateIrixPolicy();
    const manager = fakeManager(
      [
        agent({ id: "idle" }),
        agent({ id: "closed", lifecycle: "closed" }),
        agent({ id: "codex", provider: "codex" }),
        agent({ id: "fresh", updatedAt: new Date(NOW - 5 * MINUTE) }),
        agent({ id: "viewed" }),
      ],
      async () => undefined,
    );
    const isBusy = vi.fn((_entry: ManagedAgentLike) => false);
    await sweepOnce(
      manager,
      { now: () => NOW, viewed: () => new Set(["viewed"]), isBusy },
      newState(),
    );
    expect(isBusy.mock.calls.map(([entry]) => entry.id)).toEqual(["idle"]);
  });

  test("a fresh session is not closed on the first tick it is seen idle, and is on the next", async () => {
    deactivate = activateIrixPolicy();
    const session = {};
    const manager = fakeManager([agent({ id: "resumed", session })], async () => undefined);
    const state = newState();

    await sweepOnce(manager, { now: () => NOW }, state);
    expect(manager.closeAgent).not.toHaveBeenCalled();
    expect(state.candidates.get("resumed")).toBe(session);

    await sweepOnce(manager, { now: () => NOW }, state);
    expect(closedIds(manager)).toEqual(["resumed"]);
  });

  test.each(["busy", "viewed"] as const)(
    "an agent that turns %s between ticks is not closed and needs two fresh ticks",
    async (protection) => {
      deactivate = activateIrixPolicy();
      const manager = fakeManager([agent({ id: "a", session: {} })], async () => undefined);
      const state = newState();
      let protectedNow = false;
      const deps = {
        now: () => NOW,
        isBusy: () => protection === "busy" && protectedNow,
        viewed: () => new Set(protection === "viewed" && protectedNow ? ["a"] : []),
      };

      await sweepOnce(manager, deps, state);
      protectedNow = true;
      await sweepOnce(manager, deps, state);
      expect(state.candidates.has("a")).toBe(false);
      protectedNow = false;
      await sweepOnce(manager, deps, state);
      expect(manager.closeAgent).not.toHaveBeenCalled();
      await sweepOnce(manager, deps, state);
      expect(closedIds(manager)).toEqual(["a"]);
    },
  );

  test("an agent that starts running between ticks is dropped from the candidates", async () => {
    deactivate = activateIrixPolicy();
    const entry = agent({ id: "a", session: {} });
    const manager = fakeManager([entry], async () => undefined);
    const state = newState();

    await sweepOnce(manager, { now: () => NOW }, state);
    entry.lifecycle = "running";
    await sweepOnce(manager, { now: () => NOW }, state);
    expect(state.candidates.has("a")).toBe(false);
    entry.lifecycle = "idle";
    await sweepOnce(manager, { now: () => NOW }, state);
    expect(manager.closeAgent).not.toHaveBeenCalled();
  });

  test("a replaced session object resets the candidate", async () => {
    deactivate = activateIrixPolicy();
    const entry = agent({ id: "a", session: { generation: 1 } });
    const manager = fakeManager([entry], async () => undefined);
    const state = newState();

    await sweepOnce(manager, { now: () => NOW }, state);
    const replacement = { generation: 2 };
    entry.session = replacement;
    await sweepOnce(manager, { now: () => NOW }, state);
    expect(manager.closeAgent).not.toHaveBeenCalled();
    expect(state.candidates.get("a")).toBe(replacement);
    await sweepOnce(manager, { now: () => NOW }, state);
    expect(closedIds(manager)).toEqual(["a"]);
  });

  test("an agent that is no longer listed is dropped from the candidates", async () => {
    deactivate = activateIrixPolicy();
    const agents = [agent({ id: "a" }), agent({ id: "b" })];
    const manager: IdleReleaseManager = {
      listAgents: () => agents,
      closeAgent: vi.fn(async () => undefined),
    };
    const state = newState();

    await sweepOnce(manager, { now: () => NOW, isBusy: (e) => e.id === "b" }, state);
    agents.splice(0, 1);
    await sweepOnce(manager, { now: () => NOW, isBusy: () => true }, state);
    expect(state.candidates.size).toBe(0);
  });

  test("disabling the setting clears the candidates", async () => {
    deactivate = activateIrixPolicy();
    const manager = fakeManager([agent({ id: "a" })], async () => undefined);
    const state = newState();

    await sweepOnce(manager, { now: () => NOW }, state);
    expect(state.candidates.size).toBe(1);
    setIdleReleaseSettings({ enabled: false });
    await sweepOnce(manager, { now: () => NOW }, state);
    expect(state.candidates.size).toBe(0);
    setIdleReleaseSettings({ enabled: true });
    await sweepOnce(manager, { now: () => NOW }, state);
    expect(manager.closeAgent).not.toHaveBeenCalled();
    await sweepOnce(manager, { now: () => NOW }, state);
    expect(closedIds(manager)).toEqual(["a"]);
  });

  test("the Irix policy turning off clears the candidates", async () => {
    deactivate = activateIrixPolicy();
    const manager = fakeManager([agent({ id: "a" })], async () => undefined);
    const state = newState();

    await sweepOnce(manager, { now: () => NOW }, state);
    expect(state.candidates.size).toBe(1);
    deactivate();
    deactivate = null;
    await sweepOnce(manager, { now: () => NOW }, state);
    expect(state.candidates.size).toBe(0);
    expect(manager.closeAgent).not.toHaveBeenCalled();
  });

  test("viewed is recomputed right before each agent is checked", async () => {
    deactivate = activateIrixPolicy();
    let focused = new Set<string>();
    const manager = fakeManager([agent({ id: "a" }), agent({ id: "b" })], async (id) => {
      if (id === "a") {
        // The user focuses "b" while the sweep is closing "a".
        focused = new Set(["b"]);
      }
    });
    const deps = { now: () => NOW, viewed: () => focused };
    const state = newState();

    await sweepOnce(manager, deps, state);
    await sweepOnce(manager, deps, state);
    expect(closedIds(manager)).toEqual(["a"]);
  });

  test("a failing close is logged and the other agents are still released", async () => {
    deactivate = activateIrixPolicy();
    const logger = fakeLogger();
    const manager = fakeManager([agent({ id: "fails" }), agent({ id: "works" })], async (id) => {
      if (id === "fails") {
        throw new Error("close failed");
      }
    });
    const state = newState();

    await sweepOnce(manager, { now: () => NOW, logger }, state);
    await sweepOnce(manager, { now: () => NOW, logger }, state);

    expect(closedIds(manager)).toEqual(["fails", "works"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ agentId: "fails" });
    expect(logger.info.mock.calls.map(([fields]) => fields)).toEqual([
      { agentId: "works", provider: "devin", idleMinutes: 15 },
    ]);
  });

  test("a failed release is retried on the next sweep", async () => {
    deactivate = activateIrixPolicy();
    const logger = fakeLogger();
    let attempts = 0;
    const manager = fakeManager([agent({ id: "flaky" })], async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("close failed");
      }
    });
    const state = newState();

    await sweepOnce(manager, { now: () => NOW, logger }, state);
    await sweepOnce(manager, { now: () => NOW, logger }, state);
    await sweepOnce(manager, { now: () => NOW, logger }, state);

    expect(attempts).toBe(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  test("does nothing when Irix is not active", async () => {
    vi.useFakeTimers();
    const manager = fakeManager([agent()], async () => undefined);

    const stop = startIdleRelease(manager, { now: () => NOW, intervalMs: 1000 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    const state = newState();
    await sweepOnce(manager, { now: () => NOW }, state);
    await sweepOnce(manager, { now: () => NOW }, state);
    stop();

    expect(manager.closeAgent).not.toHaveBeenCalled();
  });

  test("the timer sweeps on its interval, once per manager, until stopped", async () => {
    deactivate = activateIrixPolicy();
    vi.useFakeTimers();
    const manager = fakeManager([agent()], async () => undefined);

    const stop = startIdleRelease(manager, { now: () => NOW, intervalMs: 1000 });
    const again = startIdleRelease(manager, { now: () => NOW, intervalMs: 1000 });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.closeAgent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.closeAgent).toHaveBeenCalledTimes(1);

    again();
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("each manager keeps its own candidates", async () => {
    deactivate = activateIrixPolicy();
    vi.useFakeTimers();
    const first = fakeManager([agent({ id: "a" })], async () => undefined);
    const stopFirst = startIdleRelease(first, { now: () => NOW, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const second = fakeManager([agent({ id: "a" })], async () => undefined);
    const stopSecond = startIdleRelease(second, { now: () => NOW, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.closeAgent).toHaveBeenCalledTimes(1);
    expect(second.closeAgent).not.toHaveBeenCalled();
    stopFirst();
    stopSecond();
  });

  test("skips a tick while the previous sweep is still running", async () => {
    deactivate = activateIrixPolicy();
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const manager = fakeManager(
      [agent()],
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const stop = startIdleRelease(manager, { now: () => NOW, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(4000);
    expect(manager.closeAgent).toHaveBeenCalledTimes(1);
    release();
    stop();
  });
});

describe("idle release with a real agent manager", () => {
  let deactivate: (() => void) | null = null;

  beforeEach(() => {
    resetIdleReleaseSettingsForTests();
    vi.stubEnv("PASEO_HOME", "");
    deactivate = activateIrixPolicy();
  });

  afterEach(() => {
    deactivate?.();
    deactivate = null;
    vi.unstubAllEnvs();
    resetIdleReleaseSettingsForTests();
  });

  async function setup(agentId: string) {
    const root = await mkdtemp(path.join(tmpdir(), "irix-idle-release-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const prompts: string[] = [];
    let sessionCloses = 0;
    const manager = new AgentManager({
      clients: createTestAgentClients({
        onStartTurn: (prompt) => {
          prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
        },
        closeSession: async () => {
          sessionCloses += 1;
        },
      }),
      registry: storage,
      logger,
    });
    const created = await manager.createAgent({ provider: "claude", cwd: root }, agentId, {
      workspaceId: "workspace-idle",
    });
    await startAgentRun(manager, created.id, "hello", logger, {
      runOptions: { clientMessageId: "msg-hello" },
    });
    const finished = await manager.waitForAgentEvent(created.id);
    expect(finished.status).toBe("idle");
    const cleanup = async () => {
      await manager.closeAgent(agentId).catch(() => undefined);
      await manager.flush().catch(() => undefined);
      await storage.flush().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    };
    return {
      logger,
      storage,
      manager,
      cleanup,
      prompts,
      sessionCloses: () => sessionCloses,
    };
  }

  const later = () => Date.now() + 16 * MINUTE;

  test("a released agent is closed and resumes with its full timeline", async () => {
    const agentId = "00000000-0000-4000-8000-000000000901";
    const { logger, storage, manager, cleanup } = await setup(agentId);
    try {
      const before = manager.getTimeline(agentId);
      const assistantBefore = before.filter((item) => item.type === "assistant_message");
      expect(assistantBefore.length).toBeGreaterThan(0);
      expect(before.filter((item) => item.type === "user_message")).toHaveLength(1);

      const state = newState();
      await sweepOnce(manager, { now: later }, state);
      expect(manager.getAgent(agentId)).not.toBeNull();
      await sweepOnce(manager, { now: later }, state);
      await manager.flush();
      await storage.flush();

      expect(manager.getAgent(agentId)).toBeNull();
      expect((await storage.get(agentId))?.lastStatus).toBe("closed");

      await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
      const after = manager.getTimeline(agentId);
      expect(after.filter((item) => item.type === "assistant_message")).toEqual(assistantBefore);
      expect(after.filter((item) => item.type === "user_message")).toHaveLength(
        before.filter((item) => item.type === "user_message").length,
      );
    } finally {
      await cleanup();
    }
  });

  async function expectDeliveredOnce(
    harness: Awaited<ReturnType<typeof setup>>,
    agentId: string,
    expectedCloses: number,
  ) {
    const { manager, prompts, sessionCloses } = harness;
    const finished = await manager.waitForAgentEvent(agentId);
    expect(finished.status).toBe("idle");
    expect(sessionCloses()).toBe(expectedCloses);
    expect(prompts.filter((prompt) => prompt === "again")).toHaveLength(1);
    const userMessages = manager
      .getTimeline(agentId)
      .filter((item) => item.type === "user_message");
    expect(userMessages.map((item) => item.text)).toEqual(["hello", "again"]);
  }

  function promptActions(
    harness: Awaited<ReturnType<typeof setup>>,
    agentId: string,
    state: IdleReleaseSweepState,
  ) {
    const { manager, storage, logger } = harness;
    return {
      load: () =>
        ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger }),
      run: () =>
        startAgentRun(manager, agentId, "again", logger, {
          runOptions: { clientMessageId: "msg-again" },
        }),
      sweep: (viewed: ReadonlySet<string> = new Set()) =>
        sweepOnce(manager, { now: later, viewed: () => viewed }, state),
    };
  }

  test.each([
    ["sweep first", "00000000-0000-4000-8000-000000000902"],
    ["prompt first", "00000000-0000-4000-8000-000000000903"],
  ] as const)(
    "a prompt racing a release is delivered once, to the resumed agent (%s)",
    async (order, agentId) => {
      const harness = await setup(agentId);
      try {
        const { load, run, sweep } = promptActions(harness, agentId, newState());
        // First tick: the agent becomes a candidate. The racing sweep below is the closing tick.
        await sweep();
        if (order === "sweep first") {
          const sweeping = sweep();
          const sending = load().then(run);
          await Promise.all([sweeping, sending]);
        } else {
          const sending = load().then(run);
          const sweeping = sweep();
          await Promise.all([sweeping, sending]);
        }
        await expectDeliveredOnce(harness, agentId, 1);
      } finally {
        await harness.cleanup();
      }
    },
  );

  test("a prompt that resumes a released agent is not lost to a sweep between load and run", async () => {
    const agentId = "00000000-0000-4000-8000-000000000904";
    const harness = await setup(agentId);
    try {
      const { load, run, sweep } = promptActions(harness, agentId, newState());
      await sweep();
      await sweep();
      expect(harness.manager.getAgent(agentId)).toBeNull();

      // The resumed agent keeps its old updatedAt, so it is releasable at once; the fresh
      // session is only a candidate on this tick.
      await load();
      const sweeping = sweep();
      const sending = run();
      await Promise.all([sweeping, sending]);
      await expectDeliveredOnce(harness, agentId, 1);
    } finally {
      await harness.cleanup();
    }
  });

  // KNOWN UPSTREAM HAZARD (residual after the two-tick rule). An agent that is loaded and was
  // already a candidate on the previous tick (here: viewed, then no longer viewed) is closed on
  // the next tick; a prompt that reaches `startAgentRun` before that close runs in the lifecycle
  // lane is recorded and sent, then the agent ends `closed` with no reply. Upstream `closeAgent`
  // has no only-if-idle check inside the lane, and `startAgentRun` does not wait for an
  // in-flight close. When upstream fixes it, this test fails: rewrite it to expect a reply.
  test("residual hazard: a prompt to a loaded candidate on its closing tick is recorded and not answered", async () => {
    const agentId = "00000000-0000-4000-8000-000000000905";
    const harness = await setup(agentId);
    try {
      const { manager, storage, logger, prompts } = harness;
      const { load, run, sweep } = promptActions(harness, agentId, newState());
      await sweep(new Set([agentId]));
      await sweep();
      expect(manager.getAgent(agentId)).not.toBeNull();

      await load();
      const sweeping = sweep();
      const sending = run();
      await Promise.all([sweeping, sending]);
      await manager.flush();
      await storage.flush();

      expect(prompts.filter((prompt) => prompt === "again")).toHaveLength(1);
      expect(manager.getAgent(agentId)).toBeNull();
      expect((await storage.get(agentId))?.lastStatus).toBe("closed");

      await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
      const timeline = manager.getTimeline(agentId);
      const lastUser = timeline.findLastIndex((item) => item.type === "user_message");
      expect(timeline[lastUser]).toMatchObject({ type: "user_message", text: "again" });
      expect(
        timeline.slice(lastUser + 1).filter((item) => item.type === "assistant_message"),
      ).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });
});
