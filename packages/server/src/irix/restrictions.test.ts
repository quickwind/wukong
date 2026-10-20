import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  beforeEach(() => {
    for (const name of VARIABLES) delete process.env[name];
    resetSubagentApprovalCacheForTests(null);
    deactivate = activateIrixPolicy();
  });

  afterEach(() => {
    deactivate();
    resetSubagentApprovalCacheForTests(null);
    for (const name of VARIABLES) delete process.env[name];
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
    const fakeAgentManager = {
      agents: new Map([["parent-1", parentAgent]]),
      emit: (event: Record<string, unknown>) => emitted.push(event),
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
    expect(emitted).toHaveLength(1);
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
    const thirdEvent = emitted[2]!;
    const secondRequestId = (thirdEvent.request as { id: string }).id;
    await fakeAgentManager.respondToPermission("parent-1", secondRequestId, {
      behavior: "deny",
    } as never);
    await expect(rejectPromise).rejects.toThrow(/rejected/);
    expect(created).toBe(1);
  });
});
