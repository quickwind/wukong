import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeAgentClient } from "../server/agent/providers/claude/agent.js";
import { installClaudeSessionGate, resetClaudeSessionGateForTests } from "./claude-session-gate.js";
import { activateIrixPolicy } from "./policy.js";

type Method = (...args: unknown[]) => Promise<unknown>;
type Proto = Record<"createSession" | "resumeSession", Method>;

const proto = ClaudeAgentClient.prototype as unknown as Proto;
const real = { create: proto.createSession, resume: proto.resumeSession };

describe("installClaudeSessionGate", () => {
  let deactivate: () => void;
  let session: { buildSubagentEffortHooks: () => unknown };
  const hooks = () => ({ PreToolUse: [{ hooks: [] }] });

  beforeEach(() => {
    deactivate = activateIrixPolicy();
    session = { buildSubagentEffortHooks: hooks };
    proto.createSession = vi.fn(async () => session);
    proto.resumeSession = vi.fn(async () => session);
  });

  afterEach(() => {
    deactivate();
    proto.createSession = real.create;
    proto.resumeSession = real.resume;
    resetClaudeSessionGateForTests();
  });

  it("puts the subagent ask hook on a created and on a resumed session", async () => {
    installClaudeSessionGate();
    await proto.createSession.call({}, {}, { agentId: "c" });
    const built = session.buildSubagentEffortHooks() as { PreToolUse: Array<{ matcher?: string }> };
    expect(built.PreToolUse[0]!.matcher).toBe("Task|Agent");
    session = { buildSubagentEffortHooks: hooks };
    await proto.resumeSession.call({}, {}, {}, { agentId: "c" });
    expect(session.buildSubagentEffortHooks).not.toBe(hooks);
  });

  it("installs once however often it is called", async () => {
    installClaudeSessionGate();
    const wrapped = proto.createSession;
    installClaudeSessionGate();
    expect(proto.createSession).toBe(wrapped);
  });

  it("leaves the prototype untouched when the Irix policy is off", () => {
    deactivate();
    const before = proto.createSession;
    installClaudeSessionGate();
    expect(proto.createSession).toBe(before);
  });
});
