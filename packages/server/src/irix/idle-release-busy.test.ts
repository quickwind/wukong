import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hasRunningAcpTerminal,
  hasRunningClaudeBackgroundShell,
  isAgentBusy,
  trackClaudeBackgroundShells,
} from "./idle-release-busy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function upstream(rel: string): string {
  return readFileSync(path.join(here, "..", "server", "agent", "providers", rel), "utf8");
}

describe("hasRunningAcpTerminal", () => {
  it("is true for an unreleased terminal that has not exited", () => {
    const session = { terminalEntries: new Map([["t", { released: false, exit: null }]]) };
    expect(hasRunningAcpTerminal(session)).toBe(true);
  });
  it("is false once the command exited", () => {
    const session = {
      terminalEntries: new Map([["t", { released: false, exit: { exitCode: 0 } }]]),
    };
    expect(hasRunningAcpTerminal(session)).toBe(false);
  });
  it("is false once the terminal is released", () => {
    const session = { terminalEntries: new Map([["t", { released: true, exit: null }]]) };
    expect(hasRunningAcpTerminal(session)).toBe(false);
  });
  it("is false when the field is missing or not a Map", () => {
    expect(hasRunningAcpTerminal({})).toBe(false);
    expect(hasRunningAcpTerminal({ terminalEntries: {} })).toBe(false);
    expect(hasRunningAcpTerminal(null)).toBe(false);
  });
  it("pins the upstream private field shape", () => {
    const src = upstream("acp-agent.ts");
    expect(src).toContain("private readonly terminalEntries = new Map<string, TerminalEntry>()");
    expect(src).toContain("released: boolean;");
    expect(src).toContain("exit: TerminalExit | null;");
  });
});

function fakeClaudeSession() {
  return {
    translateMessageToEvents(_m: unknown) {
      return ["ok"];
    },
  };
}

describe("trackClaudeBackgroundShells", () => {
  it("tracks a local_bash task until its notification and passes results through", () => {
    const s = fakeClaudeSession();
    trackClaudeBackgroundShells(s);
    expect(hasRunningClaudeBackgroundShell(s)).toBe(false);
    const out = s.translateMessageToEvents({
      type: "system",
      subtype: "task_started",
      task_type: "local_bash",
      task_id: "b1",
    });
    expect(out).toEqual(["ok"]);
    expect(hasRunningClaudeBackgroundShell(s)).toBe(true);
    s.translateMessageToEvents({
      type: "system",
      subtype: "task_notification",
      task_id: "b1",
      status: "completed",
    });
    expect(hasRunningClaudeBackgroundShell(s)).toBe(false);
  });
  it("ignores other task types", () => {
    const s = fakeClaudeSession();
    trackClaudeBackgroundShells(s);
    s.translateMessageToEvents({
      type: "system",
      subtype: "task_started",
      task_type: "local_agent",
      task_id: "a1",
    });
    expect(hasRunningClaudeBackgroundShell(s)).toBe(false);
  });
  it("clears on a terminal task_updated status only", () => {
    const s = fakeClaudeSession();
    trackClaudeBackgroundShells(s);
    s.translateMessageToEvents({
      type: "system",
      subtype: "task_started",
      task_type: "local_bash",
      task_id: "b1",
    });
    s.translateMessageToEvents({
      type: "system",
      subtype: "task_updated",
      task_id: "b1",
      patch: { status: "running" },
    });
    expect(hasRunningClaudeBackgroundShell(s)).toBe(true);
    s.translateMessageToEvents({
      type: "system",
      subtype: "task_updated",
      task_id: "b1",
      patch: { status: "killed" },
    });
    expect(hasRunningClaudeBackgroundShell(s)).toBe(false);
  });
  it("is idempotent per session", () => {
    let inner = 0;
    const s = {
      translateMessageToEvents(_m: unknown) {
        inner += 1;
        return ["ok"];
      },
    };
    trackClaudeBackgroundShells(s);
    trackClaudeBackgroundShells(s);
    s.translateMessageToEvents({
      type: "system",
      subtype: "task_started",
      task_type: "local_bash",
      task_id: "b1",
    });
    expect(inner).toBe(1);
    expect(hasRunningClaudeBackgroundShell(s)).toBe(true);
  });
  it("is a no-op without the method and tolerates non-objects", () => {
    expect(() => trackClaudeBackgroundShells({})).not.toThrow();
    expect(() => trackClaudeBackgroundShells(null)).not.toThrow();
    expect(hasRunningClaudeBackgroundShell({})).toBe(false);
  });
  it("pins the upstream method and its this. call site", () => {
    const src = upstream("claude/agent.ts");
    expect(src).toContain("private translateMessageToEvents(");
    expect(src).toContain("this.translateMessageToEvents(message");
  });
});

describe("isAgentBusy", () => {
  const running = { listProviderSubagents: () => [{ status: "running" }] };
  const none = { listProviderSubagents: () => [{ status: "completed" }] };
  it("is busy when a provider subagent is running, for any provider", () => {
    expect(isAgentBusy(running, { id: "a", provider: "claude", session: {} })).toBe(true);
    expect(isAgentBusy(running, { id: "a", provider: "devin", session: {} })).toBe(true);
  });
  it("uses the ACP probe for devin and the shell probe for claude", () => {
    const devin = { terminalEntries: new Map([["t", { released: false, exit: null }]]) };
    expect(isAgentBusy(none, { id: "a", provider: "devin", session: devin })).toBe(true);
    expect(isAgentBusy(none, { id: "a", provider: "claude", session: devin })).toBe(false);
    const s = fakeClaudeSession();
    trackClaudeBackgroundShells(s);
    s.translateMessageToEvents({
      type: "system",
      subtype: "task_started",
      task_type: "local_bash",
      task_id: "b",
    });
    expect(isAgentBusy(none, { id: "a", provider: "claude", session: s })).toBe(true);
    expect(isAgentBusy(none, { id: "a", provider: "devin", session: s })).toBe(false);
  });
  it("treats a manager that throws or lacks the method as not busy", () => {
    const throwing = {
      listProviderSubagents: () => {
        throw new Error("nope");
      },
    };
    expect(isAgentBusy(throwing, { id: "a", provider: "claude", session: {} })).toBe(false);
    expect(isAgentBusy({}, { id: "a", provider: "claude", session: {} })).toBe(false);
  });
});
