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
import { DEFAULT_IDLE_RELEASE, resetIdleReleaseSettingsForTests } from "./idle-release-settings.js";
import {
  type IdleReleaseManager,
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

  test("sweep closes only releasable agents and logs each release", async () => {
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

    await sweepOnce(manager, {
      now: () => NOW,
      viewed: () => new Set(["viewed"]),
      isBusy: (entry) => entry.id === "busy",
      logger,
    });

    expect(vi.mocked(manager.closeAgent).mock.calls.map(([id]) => id)).toEqual([
      "old-devin",
      "old-claude",
    ]);
    expect(logger.info.mock.calls.map(([fields]) => fields)).toEqual([
      { agentId: "old-devin", provider: "devin", idleMinutes: 20 },
      { agentId: "old-claude", provider: "claude", idleMinutes: 16 },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("a failing close is logged and the other agents are still released", async () => {
    deactivate = activateIrixPolicy();
    const logger = fakeLogger();
    const manager = fakeManager([agent({ id: "fails" }), agent({ id: "works" })], async (id) => {
      if (id === "fails") {
        throw new Error("close failed");
      }
    });

    await sweepOnce(manager, { now: () => NOW, logger });

    expect(vi.mocked(manager.closeAgent).mock.calls.map(([id]) => id)).toEqual(["fails", "works"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ agentId: "fails" });
    expect(logger.info.mock.calls.map(([fields]) => fields)).toEqual([
      { agentId: "works", provider: "devin", idleMinutes: 15 },
    ]);
  });

  test("a failed release is retried on a later sweep", async () => {
    deactivate = activateIrixPolicy();
    const logger = fakeLogger();
    let attempts = 0;
    const manager = fakeManager([agent({ id: "flaky" })], async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("close failed");
      }
    });

    await sweepOnce(manager, { now: () => NOW, logger });
    await sweepOnce(manager, { now: () => NOW, logger });

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
    await sweepOnce(manager, { now: () => NOW });
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
    expect(manager.closeAgent).toHaveBeenCalledTimes(1);

    again();
    stop();
    expect(vi.getTimerCount()).toBe(0);
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
    await vi.advanceTimersByTimeAsync(3000);
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

      await sweepOnce(manager, { now: later });
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

  async function expectDeliveredOnceToResumedAgent(
    harness: Awaited<ReturnType<typeof setup>>,
    agentId: string,
  ) {
    const { manager, prompts, sessionCloses } = harness;
    const finished = await manager.waitForAgentEvent(agentId);
    expect(finished.status).toBe("idle");
    expect(sessionCloses()).toBe(1);
    expect(prompts.filter((prompt) => prompt === "again")).toHaveLength(1);
    const userMessages = manager
      .getTimeline(agentId)
      .filter((item) => item.type === "user_message");
    expect(userMessages.map((item) => item.text)).toEqual(["hello", "again"]);
  }

  function promptActions(harness: Awaited<ReturnType<typeof setup>>, agentId: string) {
    const { manager, storage, logger } = harness;
    return {
      load: () =>
        ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger }),
      run: () =>
        startAgentRun(manager, agentId, "again", logger, {
          runOptions: { clientMessageId: "msg-again" },
        }),
      sweep: () => sweepOnce(manager, { now: later }),
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
        const { load, run, sweep } = promptActions(harness, agentId);
        if (order === "sweep first") {
          const sweeping = sweep();
          const sending = load().then(run);
          await Promise.all([sweeping, sending]);
        } else {
          const sending = load().then(run);
          const sweeping = sweep();
          await Promise.all([sweeping, sending]);
        }
        await expectDeliveredOnceToResumedAgent(harness, agentId);
      } finally {
        await harness.cleanup();
      }
    },
  );

  // KNOWN UPSTREAM HAZARD (reported in the Task 2 report). When the sweep decides to release
  // an agent that is already loaded and a prompt reaches `startAgentRun` before the close
  // runs in the lifecycle lane, upstream `closeAgent` closes the agent mid-turn: the prompt
  // is accepted ("turn_started"), recorded and sent to the provider, then the agent ends
  // `closed` with no reply and the prompt is not redelivered on resume. `closeAgent` has no
  // "only if still idle" precondition evaluated inside the lane, and `startAgentRun` does
  // not wait for an in-flight close. Flip to `test` once upstream closes that gap.
  test.fails("a prompt racing a release is delivered once, to the resumed agent (release between load and run)", async () => {
    const agentId = "00000000-0000-4000-8000-000000000904";
    const harness = await setup(agentId);
    try {
      const { load, run, sweep } = promptActions(harness, agentId);
      await load();
      const sweeping = sweep();
      const sending = run();
      await Promise.all([sweeping, sending]);
      await expectDeliveredOnceToResumedAgent(harness, agentId);
    } finally {
      await harness.cleanup();
    }
  });
});
