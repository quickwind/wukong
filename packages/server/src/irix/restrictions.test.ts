import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { paseoCommandLineGuide } from "./devin-client.js";
import { activateIrixPolicy } from "./policy.js";
import {
  assertIrixAgentMessagingAllowed,
  assertIrixModeAllowed,
  assertIrixSchedulesAllowed,
  irixSafeDefaultModeId,
  irixServerFeatures,
  withoutIrixBypassConfig,
  isIrixToolBlocked,
  withoutIrixBypassModes,
} from "./restrictions.js";
import {
  attachClaudeSessionSubagentGate,
  isSubagentApprovalLocked,
  isSubagentApprovalRequired,
  resetSubagentApprovalCacheForTests,
  setSubagentApprovalRequired,
} from "./subagent-approval.js";

const VARIABLES = [
  "IRIX_UNRESTRICTED",
  "IRIX_ALLOW_SCHEDULES",
  "IRIX_ALLOW_AGENT_MESSAGING",
  "IRIX_ALLOW_BYPASS_MODES",
  "IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL",
];

describe("Irix restrictions", () => {
  let deactivate: () => void;
  let originalPaseoHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    originalPaseoHome = process.env.PASEO_HOME;
    tempHome = mkdtempSync(path.join(os.tmpdir(), "irix-restrictions-test-"));
    process.env.PASEO_HOME = tempHome;
    for (const name of VARIABLES) delete process.env[name];
    resetSubagentApprovalCacheForTests(null);
    deactivate = activateIrixPolicy();
  });

  afterEach(() => {
    deactivate();
    resetSubagentApprovalCacheForTests(null);
    for (const name of VARIABLES) delete process.env[name];
    if (originalPaseoHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = originalPaseoHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("blocks schedules, agent messaging and bypass modes by default", () => {
    expect(isIrixToolBlocked("create_schedule")).toBe(true);
    expect(isIrixToolBlocked("create_heartbeat")).toBe(true);
    expect(isIrixToolBlocked("send_agent_prompt")).toBe(true);
    expect(isIrixToolBlocked("list_agents")).toBe(false);
    expect(() => assertIrixSchedulesAllowed()).toThrow();
    expect(() => assertIrixAgentMessagingAllowed("agent-1")).toThrow();
    expect(() => assertIrixAgentMessagingAllowed(undefined)).not.toThrow();
    expect(() => assertIrixModeAllowed({ modeId: "bypassPermissions" })).toThrow();
    expect(() => assertIrixModeAllowed({ featureValues: { auto_accept: true } })).toThrow();
    expect(() => assertIrixModeAllowed({ modeId: "default" })).not.toThrow();
    expect(
      withoutIrixBypassModes([
        { id: "default" },
        { id: "bypassPermissions" },
        { id: "x", isUnattended: true },
      ]),
    ).toEqual([{ id: "default" }]);
    expect(paseoCommandLineGuide("a1")).not.toContain("irix send");
  });

  it("learns a provider's own unattended modes, whatever they are named", () => {
    withoutIrixBypassModes([{ id: "default" }, { id: "accept-all-edits", isUnattended: true }]);
    expect(() => assertIrixModeAllowed({ modeId: "accept-all-edits" })).toThrow();
  });

  it("does not offer a bypass default, and lets a stored agent fall back to the default mode", () => {
    expect(irixSafeDefaultModeId("bypassPermissions")).toBeUndefined();
    expect(irixSafeDefaultModeId("default")).toBe("default");
    expect(
      withoutIrixBypassConfig({
        modeId: "bypassPermissions",
        featureValues: { auto_accept: true, other: 1 },
      }),
    ).toEqual({ featureValues: { auto_accept: false, other: 1 } });
    expect(withoutIrixBypassConfig({ modeId: "default" })).toEqual({ modeId: "default" });
  });

  it("IRIX_UNRESTRICTED lifts everything", () => {
    process.env.IRIX_UNRESTRICTED = "1";
    expect(isIrixToolBlocked("create_schedule")).toBe(false);
    expect(isIrixToolBlocked("send_agent_prompt")).toBe(false);
    expect(() => assertIrixSchedulesAllowed()).not.toThrow();
    expect(() => assertIrixAgentMessagingAllowed("agent-1")).not.toThrow();
    expect(() => assertIrixModeAllowed({ modeId: "bypassPermissions" })).not.toThrow();
    expect(paseoCommandLineGuide("a1")).toContain("irix send");
  });

  it("each IRIX_ALLOW_* variable lifts only its own restriction", () => {
    process.env.IRIX_ALLOW_SCHEDULES = "1";
    expect(isIrixToolBlocked("create_schedule")).toBe(false);
    expect(isIrixToolBlocked("send_agent_prompt")).toBe(true);
    expect(() => assertIrixModeAllowed({ modeId: "bypassPermissions" })).toThrow();
  });

  it("does nothing when the Irix policy is off", () => {
    deactivate();
    expect(isIrixToolBlocked("create_schedule")).toBe(false);
    expect(() => assertIrixModeAllowed({ modeId: "bypassPermissions" })).not.toThrow();
    deactivate = activateIrixPolicy();
  });

  it("enforces mandatory subagent approval by default and locks the control switch", () => {
    expect(isSubagentApprovalLocked()).toBe(true);
    expect(isSubagentApprovalRequired()).toBe(true);
    expect(() => setSubagentApprovalRequired(false)).toThrow();
    expect(irixServerFeatures()).toMatchObject({
      subagentApprovalLocked: true,
      requireSubagentApproval: true,
    });

    const claudeConfig = withoutIrixBypassConfig({
      provider: "claude",
      modeId: "default",
      providerOptions: {
        allowedTools: ["Read", "Task", "Agent"],
        settings: { permissions: { allow: ["Task", "Read"] } },
      },
    });
    expect(claudeConfig.providerOptions).toEqual({
      allowedTools: ["Read"],
      settings: {
        permissions: {
          allow: ["Read"],
          ask: ["Task", "Agent"],
        },
      },
    });
  });

  it("allows toggling mandatory subagent approval off when unlocked, falling back to scenario settings", () => {
    process.env.IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL = "1";
    expect(isSubagentApprovalLocked()).toBe(false);
    expect(isSubagentApprovalRequired()).toBe(true);

    setSubagentApprovalRequired(false);
    expect(isSubagentApprovalRequired()).toBe(false);
    expect(irixServerFeatures()).toMatchObject({
      subagentApprovalLocked: false,
      requireSubagentApproval: false,
    });

    const claudeConfig = withoutIrixBypassConfig({
      provider: "claude",
      modeId: "default",
      providerOptions: {
        allowedTools: ["Read", "Task"],
      },
    });
    expect(claudeConfig.providerOptions).toEqual({
      allowedTools: ["Read", "Task"],
    });
  });

  it("gates MCP create_agent on parent agent approval when mandatory subagent approval is enabled", async () => {
    const parentAgent = {
      id: "parent-1",
      config: { provider: "claude", cwd: "/tmp" },
      pendingPermissions: new Map(),
    };
    const emitted: Array<Record<string, unknown>> = [];
    // AgentManager has no `emit`: a card is an entry in the agent's pendingPermissions.
    const recordedSet = parentAgent.pendingPermissions.set.bind(parentAgent.pendingPermissions);
    parentAgent.pendingPermissions.set = (key: unknown, value: unknown) => {
      emitted.push({ type: "permission_requested", agentId: "parent-1", request: value });
      return recordedSet(key, value);
    };
    const recordedDelete = parentAgent.pendingPermissions.delete.bind(
      parentAgent.pendingPermissions,
    );
    parentAgent.pendingPermissions.delete = (key: unknown) => {
      if (parentAgent.pendingPermissions.has(key)) {
        emitted.push({ type: "permission_resolved", agentId: "parent-1", requestId: key });
      }
      return recordedDelete(key);
    };
    const fakeAgentManager = {
      agents: new Map([["parent-1", parentAgent]]),
      respondToPermission: async () => {},
    };
    const tools = new Map<
      string,
      {
        name: string;
        handler: (
          input: Record<string, unknown>,
          context?: { callerAgentId?: string },
        ) => Promise<unknown>;
      }
    >();
    expect(
      isIrixToolBlocked("create_agent", tools, {
        agentManager: fakeAgentManager,
        callerAgentId: "parent-1",
      }),
    ).toBe(false);

    let created = 0;
    tools.set("create_agent", {
      name: "create_agent",
      handler: async () => {
        created += 1;
        return { id: "child-1" };
      },
    });

    const tool = tools.get("create_agent")!;
    const createPromise = tool.handler({ provider: "claude", prompt: "run child" });
    expect(created).toBe(0);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(emitted[0]).toMatchObject({
      type: "permission_requested",
      agentId: "parent-1",
    });
    const firstEvent = emitted[0]!;
    const requestId = (firstEvent.request as { id: string }).id;

    await fakeAgentManager.respondToPermission("parent-1", requestId, {
      behavior: "allow",
    } as never);
    await expect(createPromise).resolves.toEqual({ id: "child-1" });
    expect(created).toBe(1);

    // Rejecting blocks child creation before handler runs
    const rejectPromise = tool.handler({ provider: "claude", prompt: "run child 2" });
    await vi.waitFor(() => expect(emitted).toHaveLength(3));
    const thirdEvent = emitted[2]!;
    const secondRequestId = (thirdEvent.request as { id: string }).id;
    await fakeAgentManager.respondToPermission("parent-1", secondRequestId, {
      behavior: "deny",
    } as never);
    await expect(rejectPromise).rejects.toThrow(/rejected/);
    expect(created).toBe(1);
  });

  it("gates MCP schedule tools on parent approval, once per call, and skips a name-only update", async () => {
    const parentAgent = {
      id: "parent-1",
      config: { provider: "claude", cwd: "/tmp" },
      pendingPermissions: new Map(),
    };
    const emitted: Array<Record<string, unknown>> = [];
    // AgentManager has no `emit`: a card is an entry in the agent's pendingPermissions.
    const recordedSet = parentAgent.pendingPermissions.set.bind(parentAgent.pendingPermissions);
    parentAgent.pendingPermissions.set = (key: unknown, value: unknown) => {
      emitted.push({ type: "permission_requested", agentId: "parent-1", request: value });
      return recordedSet(key, value);
    };
    const fakeAgentManager = {
      agents: new Map([["parent-1", parentAgent]]),
      respondToPermission: async () => {},
    };
    process.env.IRIX_UNRESTRICTED = "1";
    const tools = new Map<
      string,
      { name: string; handler: (input: Record<string, unknown>) => Promise<unknown> }
    >();
    isIrixToolBlocked("create_schedule", tools, {
      agentManager: fakeAgentManager,
      callerAgentId: "parent-1",
      scheduleService: {
        inspect: async () => ({ status: "paused", prompt: "p", target: { type: "new-agent" } }),
      },
    });
    const ran: string[] = [];
    for (const name of [
      "create_schedule",
      "resume_schedule",
      "run_schedule_once",
      "update_schedule",
    ]) {
      tools.set(name, {
        name,
        handler: async () => {
          ran.push(name);
          return {};
        },
      });
    }
    const requests = () => emitted.filter((event) => event.type === "permission_requested");
    const answer = async (index: number, behavior: "allow" | "deny") => {
      const request = requests()[index]!.request as { id: string };
      await fakeAgentManager.respondToPermission("parent-1", request.id, { behavior } as never);
    };

    const create = tools.get("create_schedule")!.handler({ prompt: "p", cron: "* * * * *" });
    expect(ran).toEqual([]);
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    await answer(0, "allow");
    await create;
    expect(ran).toEqual(["create_schedule"]);

    const runOnce = tools.get("run_schedule_once")!.handler({ id: "s1" });
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    await answer(1, "deny");
    await expect(runOnce).rejects.toThrow(/rejected/);
    expect(ran).toEqual(["create_schedule"]);

    await tools.get("update_schedule")!.handler({ id: "s1", name: "renamed" });
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    expect(ran).toEqual(["create_schedule", "update_schedule"]);

    const edit = tools.get("update_schedule")!.handler({ id: "s1", cron: "0 * * * *" });
    await vi.waitFor(() => expect(requests()).toHaveLength(3));
    await answer(2, "allow");
    await edit;
    expect(ran).toEqual(["create_schedule", "update_schedule", "update_schedule"]);
  });

  it("makes Claude ask before its own Task/Agent tool, and only while approval is required", async () => {
    const observe = async () => ({});
    const session: Record<string, unknown> = {
      buildSubagentEffortHooks: () => ({
        PreToolUse: [{ hooks: [observe] }],
        SubagentStop: [{ hooks: [observe] }],
      }),
    };
    attachClaudeSessionSubagentGate(session);

    const hooks = (
      session.buildSubagentEffortHooks as () => Record<
        string,
        Array<{ matcher?: string; hooks: Array<() => Promise<unknown>> }>
      >
    )();
    expect(hooks.SubagentStop).toHaveLength(1);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse![0]!.matcher).toBe("Task|Agent");
    expect(hooks.PreToolUse![1]!.hooks).toEqual([observe]);

    const ask = hooks.PreToolUse![0]!.hooks[0]!;
    resetSubagentApprovalCacheForTests(true);
    await expect(ask()).resolves.toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" },
    });
    // The setting can be turned off only where its control is unlocked.
    process.env.IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL = "1";
    resetSubagentApprovalCacheForTests(false);
    await expect(ask()).resolves.toEqual({});

    // A second attach does not add the hook twice.
    attachClaudeSessionSubagentGate(session);
    const again = (session.buildSubagentEffortHooks as () => typeof hooks)();
    expect(again.PreToolUse).toHaveLength(2);
  });

  it("replaces Claude's JSON card for its Task/Agent tool with a form that names the model, and leaves other cards alone", () => {
    const pushed: Array<{ type: string; request: { name: string; detail?: unknown } }> = [];
    const session: Record<string, unknown> = {
      config: { model: "claude-haiku-5-5" },
      pushEvent: (event: (typeof pushed)[number]) => pushed.push(event),
    };
    attachClaudeSessionSubagentGate(session);
    const push = session.pushEvent as (event: unknown) => void;

    push({
      type: "permission_requested",
      request: {
        name: "Agent",
        input: { subagent_type: "Explore", model: "sonnet", prompt: "look around" },
        detail: { type: "unknown" },
      },
    });
    push({ type: "permission_requested", request: { name: "Bash", detail: { type: "shell" } } });
    push({ type: "permission_resolved", requestId: "x" });

    expect(pushed).toHaveLength(3);
    expect(pushed[0]!.request.detail).toEqual({
      type: "plain_text",
      text: "Subagent: Explore\nModel: sonnet\nPrompt: look around",
    });
    expect(pushed[1]!.request.detail).toEqual({ type: "shell" });
  });
});
