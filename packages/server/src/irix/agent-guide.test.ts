import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { irixAgentGuide } from "./agent-guide.js";
import { activateIrixPolicy } from "./policy.js";
import { resetSubagentApprovalCacheForTests } from "./subagent-approval.js";

const SWITCH_VARIABLES = [
  "IRIX_UNRESTRICTED",
  "IRIX_ALLOW_AGENT_MESSAGING",
  "IRIX_ALLOW_SCHEDULES",
  "IRIX_ALLOW_BYPASS_MODES",
  "IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL",
] as const;

describe("the agent guide follows the host's switches", () => {
  let deactivate: () => void;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of SWITCH_VARIABLES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    resetSubagentApprovalCacheForTests(null);
    deactivate = activateIrixPolicy();
  });

  afterEach(() => {
    deactivate();
    resetSubagentApprovalCacheForTests(null);
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("teaches Claude the irix commands, not Devin's subagent tool", () => {
    const guide = irixAgentGuide({ provider: "claude", channel: "cli", agentId: "abc-123" });
    for (const command of [
      "irix agent ls",
      "irix logs",
      "irix wait",
      "irix run",
      "irix script ls",
      "IRIX_RG_PATH",
    ]) {
      expect(guide).toContain(command);
    }
    expect(guide).toContain("abc-123");
    expect(guide).toContain("MCP tools are not available");
    expect(guide).toContain("the Task or Agent tool");
    expect(guide).toContain("ripgrep");
    expect(guide).not.toContain("run_subagent");
  });

  it("tells the agent about ripgrep via IRIX_RG_PATH", () => {
    const guide = irixAgentGuide({ provider: "claude", channel: "cli" });
    expect(guide).toContain("IRIX_RG_PATH");
    expect(guide).toContain("ripgrep");
    expect(guide).toContain("Fast file and content search");
  });

  it("leaves out sending, and says how to hand work over, while messages between agents are off", () => {
    const off = irixAgentGuide({ provider: "claude", channel: "cli" });
    expect(off).not.toContain("irix send");
    expect(off).toContain("start a new agent with the whole task");

    process.env.IRIX_ALLOW_AGENT_MESSAGING = "1";
    const on = irixAgentGuide({ provider: "claude", channel: "cli" });
    expect(on).toContain("irix send");
    expect(on).toContain("report back");
    expect(on).not.toContain("start a new agent with the whole task");
  });

  it("teaches schedules only once the host allows them, and never lists what is off", () => {
    const off = irixAgentGuide({ provider: "devin", channel: "cli" });
    expect(off).not.toContain("irix schedule");
    expect(off).not.toContain("Switched off");

    process.env.IRIX_ALLOW_SCHEDULES = "1";
    const on = irixAgentGuide({ provider: "devin", channel: "cli" });
    expect(on).toContain("irix schedule create");
    expect(on).toContain("--cron");
  });

  it("over MCP, gives only the approval policy", () => {
    const guide = irixAgentGuide({ provider: "claude", channel: "mcp", agentId: "abc" });
    expect(guide).not.toContain("irix agent ls");
    expect(guide).toContain("MANDATORY SUBAGENT APPROVAL");
    expect(guide).toContain("create_agent");
  });

  it("is empty over MCP on a host with nothing switched off and no approval", () => {
    process.env.IRIX_UNRESTRICTED = "1";
    resetSubagentApprovalCacheForTests(false);
    expect(irixAgentGuide({ provider: "claude", channel: "mcp" })).toBe("");
  });
});
