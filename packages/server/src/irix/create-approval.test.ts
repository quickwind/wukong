import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertIrixCreateApproved,
  cancelIrixApprovalsFor,
  assertIrixMcpScheduleApproved,
  assertIrixScheduleApproved,
  rememberIrixApprovalHost,
  resetIrixApprovalHostForTests,
} from "./create-approval.js";
import { activateIrixPolicy } from "./policy.js";
import { resetSubagentApprovalCacheForTests } from "./subagent-approval.js";

function fakeManager(agentIds: string[]) {
  const emitted: Array<Record<string, unknown>> = [];
  // AgentManager has no `emit`: a card is an entry in the agent's pendingPermissions.
  const pending = (agentId: string) =>
    new (class extends Map {
      override set(key: string, value: unknown) {
        emitted.push({ type: "permission_requested", agentId, request: value });
        return super.set(key, value);
      }
      override delete(key: string) {
        if (super.has(key)) {
          emitted.push({ type: "permission_resolved", agentId, requestId: key });
        }
        return super.delete(key);
      }
    })();
  const notified: string[] = [];
  const manager = {
    notifyAgentState: (agentId: string) => notified.push(agentId),
    agents: new Map(
      agentIds.map((id) => [
        id,
        { id, config: { provider: "claude", cwd: "/tmp" }, pendingPermissions: pending(id) },
      ]),
    ),
    respondToPermission: async (..._args: unknown[]) => {},
    cancelAgentRun: async (_agentId: string) => ({ cancelled: true }),
  };
  const requests = () => emitted.filter((event) => event.type === "permission_requested");
  // The approval hook wraps respondToPermission when it first sees the manager.
  const answer = async (index: number, behavior: "allow" | "deny") => {
    const request = requests()[index]!.request as { id: string; input: Record<string, unknown> };
    await manager.respondToPermission("caller", request.id, { behavior } as never);
  };
  return { emitted, notified, requests, manager, answer };
}

function schedules(schedule: { status: string; prompt: string; target: { type: string } } | null) {
  return {
    inspect: async (id: string) => {
      if (!schedule) {
        throw new Error(`Schedule not found: ${id}`);
      }
      return schedule;
    },
  };
}

const NEW_AGENT_SCHEDULE = {
  status: "paused",
  prompt: "delete the release branch",
  target: { type: "new-agent" },
};

describe("Irix creation and schedule approval", () => {
  let deactivate: () => void;

  beforeEach(() => {
    vi.stubEnv("IRIX_ALLOW_SCHEDULES", "1");
    // Some tests turn the approval setting off, which Irix allows only with this.
    vi.stubEnv("IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL", "1");
    deactivate = activateIrixPolicy();
    resetSubagentApprovalCacheForTests(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    deactivate();
    resetSubagentApprovalCacheForTests(null);
    resetIrixApprovalHostForTests();
  });

  it("denies after the ten-minute timeout and takes the card down", async () => {
    vi.useFakeTimers();
    const { manager, requests, emitted } = fakeManager(["caller"]);
    const pending = assertIrixCreateApproved(manager, "agent", {
      requestId: "r1",
      callerAgentId: "caller",
      initialPrompt: "work",
    });
    const rejection = expect(pending).rejects.toThrow(/rejected by user/);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
    expect(emitted.some((event) => event.type === "permission_resolved")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(emitted.some((event) => event.type === "permission_resolved")).toBe(true);
  });

  it("says no card could be shown, not that a person refused, when the caller is unknown", async () => {
    const { manager, requests } = fakeManager([]);
    await expect(
      assertIrixCreateApproved(manager, "agent", { requestId: "r1", callerAgentId: "ghost" }),
    ).rejects.toThrow(/could not be shown to calling agent ghost/);
    expect(requests()).toHaveLength(0);
  });

  it("denies a pending card when the calling agent is interrupted (cancelAgentRun)", async () => {
    const { manager, requests } = fakeManager(["caller"]);
    const asked = assertIrixCreateApproved(manager, "agent", {
      requestId: "r1",
      callerAgentId: "caller",
    });
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    const rejected = expect(asked).rejects.toThrow();
    await manager.cancelAgentRun("caller");
    await rejected;
  });

  it("does not ask without a calling agent or with the setting off", async () => {
    const { manager, requests } = fakeManager(["caller"]);
    await assertIrixCreateApproved(manager, "agent", { requestId: "r1" });
    resetSubagentApprovalCacheForTests(false);
    await assertIrixCreateApproved(manager, "agent", { requestId: "r2", callerAgentId: "caller" });
    expect(requests()).toHaveLength(0);
  });

  it("raises one card for a workspace created with an agent, and the mark does not travel over JSON", async () => {
    const { manager, requests, answer } = fakeManager(["caller"]);
    const agent = { callerAgentId: "caller", initialPrompt: "work" };
    const workspaceStep = assertIrixCreateApproved(manager, "workspace", {
      requestId: "r1",
      agent,
    });
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    await answer(0, "allow");
    await workspaceStep;

    // The session spreads the agent input into the agent step's request.
    await assertIrixCreateApproved(manager, "agent", { ...agent, requestId: "r1" });
    expect(requests()).toHaveLength(1);

    // A request that arrives over the wire, even with the same id, is asked again.
    const resent = JSON.parse(JSON.stringify({ ...agent, requestId: "r1" }));
    const asked = assertIrixCreateApproved(manager, "agent", resent);
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    await answer(1, "deny");
    await expect(asked).rejects.toThrow(/rejected by user/);
  });

  it("does not ask again for a resent workspace request the daemon answers from its record", async () => {
    const { manager, requests } = fakeManager(["caller"]);
    rememberIrixApprovalHost({
      creationService: {
        subscribe: async () => ({
          snapshot: { phase: "completed", agent: { id: "child" } },
          unsubscribe: () => {},
        }),
      },
    });
    await assertIrixCreateApproved(manager, "workspace", {
      requestId: "r1",
      idempotencyKey: "k1",
      callerAgentId: "caller",
      agent: { initialPrompt: "work" },
    });
    expect(requests()).toHaveLength(0);
  });

  it("shows a schedule's stored prompt when running it once", async () => {
    const { manager, requests, answer } = fakeManager(["caller"]);
    rememberIrixApprovalHost({ agentManager: manager });
    const run = assertIrixScheduleApproved(schedules(NEW_AGENT_SCHEDULE), "run-once", {
      callerAgentId: "caller",
      scheduleId: "s1",
    });
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    const card = requests()[0]!.request as { input: Record<string, unknown> };
    expect(card.input).toMatchObject({
      operation: "run-once",
      scheduleId: "s1",
      prompt: "delete the release branch",
    });
    await answer(0, "allow");
    await run;
  });

  it("does not ask for a schedule that messages an existing agent, or for resuming an active one", async () => {
    const { manager, requests } = fakeManager(["caller"]);
    rememberIrixApprovalHost({ agentManager: manager });
    const heartbeat = schedules({ status: "paused", prompt: "p", target: { type: "agent" } });
    await assertIrixScheduleApproved(heartbeat, "run-once", {
      callerAgentId: "caller",
      scheduleId: "s1",
    });
    await assertIrixScheduleApproved(heartbeat, "create", {
      callerAgentId: "caller",
      target: { type: "agent" },
    });
    const active = schedules({ ...NEW_AGENT_SCHEDULE, status: "active" });
    await assertIrixScheduleApproved(active, "resume", {
      callerAgentId: "caller",
      scheduleId: "s1",
    });
    expect(requests()).toHaveLength(0);
  });

  it("leaves a missing or agent-target schedule to the MCP tool's own error, with no card", async () => {
    const { manager, requests } = fakeManager(["caller"]);
    const context = { agentManager: manager, callerAgentId: "caller" };
    await assertIrixMcpScheduleApproved(
      "run_schedule_once",
      { id: "missing" },
      { ...context, schedules: schedules(null) },
    );
    await assertIrixMcpScheduleApproved(
      "update_schedule",
      { id: "s1", prompt: "new" },
      {
        ...context,
        schedules: schedules({ status: "active", prompt: "p", target: { type: "agent" } }),
      },
    );
    expect(requests()).toHaveLength(0);
  });

  it("joins a pending keyed request instead of raising a second card, and remembers a refusal", async () => {
    const { manager, requests, answer } = fakeManager(["caller"]);
    const request = { requestId: "r1", idempotencyKey: "k1", callerAgentId: "caller" };
    const first = assertIrixCreateApproved(manager, "agent", request);
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    const repeat = assertIrixCreateApproved(manager, "agent", { ...request, requestId: "r2" });
    await vi.advanceTimersByTimeAsync?.(0).catch(() => undefined);
    expect(requests()).toHaveLength(1);

    await answer(0, "deny");
    await expect(first).rejects.toThrow(/rejected by user/);
    await expect(repeat).rejects.toThrow(/rejected by user/);

    // The same key is refused again with no new card.
    await expect(
      assertIrixCreateApproved(manager, "agent", { ...request, requestId: "r3" }),
    ).rejects.toThrow(/rejected by user/);
    expect(requests()).toHaveLength(1);

    // Another request from the same caller is a new question.
    const other = assertIrixCreateApproved(manager, "agent", {
      ...request,
      idempotencyKey: "k2",
    });
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    await answer(1, "allow");
    await other;
  });

  it("keeps a keyed request's card when its connection closes, and withdraws a keyless one", async () => {
    const { manager, requests, emitted } = fakeManager(["caller"]);
    const owner = {};
    const keyed = assertIrixCreateApproved(
      manager,
      "agent",
      { requestId: "r1", idempotencyKey: "k1", callerAgentId: "caller" },
      owner,
    );
    const keyless = assertIrixCreateApproved(
      manager,
      "agent",
      { requestId: "r2", callerAgentId: "caller" },
      owner,
    );
    const keylessRefusal = expect(keyless).rejects.toThrow(/rejected by user/);
    await vi.waitFor(() => expect(requests()).toHaveLength(2));

    cancelIrixApprovalsFor(owner);
    await keylessRefusal;
    expect(emitted.filter((event) => event.type === "permission_resolved")).toHaveLength(1);

    const request = requests()[0]!.request as { id: string };
    await manager.respondToPermission("caller", request.id, { behavior: "allow" } as never);
    await keyed;
  });

  it("tells clients the agent's state changed when a card is raised and when it is answered", async () => {
    const { manager, requests, answer, notified } = fakeManager(["caller"]);
    const asked = assertIrixCreateApproved(manager, "agent", {
      requestId: "r1",
      callerAgentId: "caller",
    });
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect(notified).toEqual(["caller"]);
    await answer(0, "allow");
    await asked;
    // An idle agent shows the card from its state, so the answer must refresh that too.
    expect(notified).toEqual(["caller", "caller"]);
  });

  it("shows the model and the other choices as a form on the card, not only as JSON", async () => {
    const { manager, requests, answer } = fakeManager(["caller"]);
    const asked = assertIrixCreateApproved(manager, "agent", {
      requestId: "r1",
      callerAgentId: "caller",
      initialPrompt: "Reply PONG",
      config: {
        provider: "claude",
        model: "claude-haiku-5-5",
        thinkingOptionId: "medium",
        cwd: "/repo",
        title: "child",
      },
    });
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    const card = requests()[0]!.request as {
      input: Record<string, unknown>;
      detail: { type: string; text: string };
    };
    expect(card.input).toMatchObject({ provider: "claude", model: "claude-haiku-5-5" });
    expect(card.detail.type).toBe("plain_text");
    expect(card.detail.text.split("\n")).toEqual([
      "Provider: claude",
      "Model: claude-haiku-5-5",
      "Thinking: medium",
      "Directory: /repo",
      "Title: child",
      "Prompt: Reply PONG",
    ]);
    await answer(0, "allow");
    await asked;
  });
});
