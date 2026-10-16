import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { paseoCommandLineGuide } from "./devin-client.js";
import { activateIrixPolicy } from "./policy.js";
import {
  assertIrixAgentMessagingAllowed,
  assertIrixModeAllowed,
  assertIrixSchedulesAllowed,
  isIrixToolBlocked,
  withoutIrixBypassModes,
} from "./restrictions.js";

const VARIABLES = [
  "IRIX_UNRESTRICTED",
  "IRIX_ALLOW_SCHEDULES",
  "IRIX_ALLOW_AGENT_MESSAGING",
  "IRIX_ALLOW_BYPASS_MODES",
];

describe("Irix restrictions", () => {
  let deactivate: () => void;

  beforeEach(() => {
    for (const name of VARIABLES) delete process.env[name];
    deactivate = activateIrixPolicy();
  });

  afterEach(() => {
    deactivate();
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
});
