import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../server/agent/agent-sdk-types.js";
import { wrapSessionProvider } from "../server/agent/provider-registry.js";
import {
  hasRunningAcpTerminal,
  hasRunningClaudeBackgroundShell,
  isAgentBusy,
  trackClaudeBackgroundShells,
} from "./idle-release-busy.js";
import { registerRawSession, resetIdleReleaseSessionsForTests } from "./idle-release-sessions.js";

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
  it("fails closed: a session whose terminals cannot be inspected counts as running one", () => {
    expect(hasRunningAcpTerminal({})).toBe(true);
    expect(hasRunningAcpTerminal({ terminalEntries: {} })).toBe(true);
    expect(hasRunningAcpTerminal(null)).toBe(true);
  });
  it("is false for an empty terminal map", () => {
    expect(hasRunningAcpTerminal({ terminalEntries: new Map() })).toBe(false);
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
  });
  it("fails closed: a session that was never tracked counts as running a shell", () => {
    expect(hasRunningClaudeBackgroundShell({})).toBe(true);
    expect(hasRunningClaudeBackgroundShell(fakeClaudeSession())).toBe(true);
    expect(hasRunningClaudeBackgroundShell(null)).toBe(true);
  });
  it("a session it fails to wrap stays untracked, so it counts as running a shell", () => {
    const frozen = Object.freeze(fakeClaudeSession());
    expect(() => trackClaudeBackgroundShells(frozen)).toThrow();
    expect(hasRunningClaudeBackgroundShell(frozen)).toBe(true);
  });
  it("a tracked session with no shell is not running one", () => {
    const s = fakeClaudeSession();
    trackClaudeBackgroundShells(s);
    expect(hasRunningClaudeBackgroundShell(s)).toBe(false);
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
  afterEach(() => {
    resetIdleReleaseSessionsForTests();
  });
  it("is busy when a provider subagent is running, for any provider", () => {
    registerRawSession("a", { terminalEntries: new Map() });
    expect(isAgentBusy(running, { id: "a", provider: "claude", session: {} })).toBe(true);
    expect(isAgentBusy(running, { id: "a", provider: "devin", session: {} })).toBe(true);
  });
  it("probes the registered raw session, not the session the manager holds", () => {
    const devin = { terminalEntries: new Map([["t", { released: false, exit: null }]]) };
    registerRawSession("d", devin);
    expect(isAgentBusy(none, { id: "d", provider: "devin", session: {} })).toBe(true);
    const s = fakeClaudeSession();
    trackClaudeBackgroundShells(s);
    registerRawSession("c", s);
    expect(isAgentBusy(none, { id: "c", provider: "claude", session: {} })).toBe(false);
    s.translateMessageToEvents({
      type: "system",
      subtype: "task_started",
      task_type: "local_bash",
      task_id: "b",
    });
    expect(isAgentBusy(none, { id: "c", provider: "claude", session: {} })).toBe(true);
  });
  it("an untracked Claude session is busy, so it is never released", () => {
    registerRawSession("a", {});
    expect(isAgentBusy(none, { id: "a", provider: "claude", session: {} })).toBe(true);
  });
  it("fails closed and warns when the raw session cannot be resolved", () => {
    const logger = { warn: vi.fn() };
    expect(isAgentBusy(none, { id: "x", provider: "devin", session: {} }, logger)).toBe(true);
    expect(isAgentBusy(none, { id: "y", provider: "claude", session: {} }, logger)).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ agentId: "x", provider: "devin" });
  });
  it("does not need a raw session for other providers", () => {
    expect(isAgentBusy(none, { id: "o", provider: "codex", session: {} })).toBe(false);
  });
  it("fails closed when listing subagents throws, and warns once per call", () => {
    const throwing = {
      listProviderSubagents: () => {
        throw new Error("nope");
      },
    };
    const logger = { warn: vi.fn() };
    const tracked = fakeClaudeSession();
    trackClaudeBackgroundShells(tracked);
    registerRawSession("a", tracked);
    expect(isAgentBusy(throwing, { id: "a", provider: "claude", session: {} }, logger)).toBe(true);
    expect(isAgentBusy(throwing, { id: "d", provider: "devin", session: {} })).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ agentId: "a" });
  });
  it("treats a manager that lacks the method as having no subagents", () => {
    const tracked = fakeClaudeSession();
    trackClaudeBackgroundShells(tracked);
    registerRawSession("a", tracked);
    registerRawSession("d", { terminalEntries: new Map() });
    expect(isAgentBusy({}, { id: "a", provider: "claude", session: {} })).toBe(false);
    expect(isAgentBusy({}, { id: "d", provider: "devin", session: {} })).toBe(false);
  });
});

// The manager holds what the registry's `wrapSessionProvider` returns: a facade with only the
// AgentSession interface. Probes must reach the real session behind it.
describe("isAgentBusy behind the real registry facade", () => {
  const none = { listProviderSubagents: () => [] };
  afterEach(() => {
    resetIdleReleaseSessionsForTests();
  });

  function facade(provider: string, raw: object) {
    return wrapSessionProvider(provider, raw as unknown as AgentSession);
  }

  it("the facade hides the private members the probes need", () => {
    const raw = { terminalEntries: new Map(), translateMessageToEvents: () => [] };
    const wrapped = facade("devin", raw) as unknown as Record<string, unknown>;
    expect(wrapped.terminalEntries).toBeUndefined();
    expect(wrapped.translateMessageToEvents).toBeUndefined();
  });

  it("devin: busy while a registered raw session runs a terminal, idle once it exits", () => {
    const entry: { released: boolean; exit: { exitCode: number } | null } = {
      released: false,
      exit: null,
    };
    const raw = { terminalEntries: new Map([["t", entry]]) };
    registerRawSession("d", raw);
    const agent = { id: "d", provider: "devin", session: facade("devin", raw) };
    expect(isAgentBusy(none, agent)).toBe(true);
    entry.exit = { exitCode: 0 };
    expect(isAgentBusy(none, agent)).toBe(false);
  });

  it("devin: a raw session that was never registered is busy", () => {
    const raw = { terminalEntries: new Map() };
    expect(isAgentBusy(none, { id: "d", provider: "devin", session: facade("devin", raw) })).toBe(
      true,
    );
  });

  it("claude: busy while a tracked local_bash task runs, idle once it ends", () => {
    const raw = fakeClaudeSession();
    trackClaudeBackgroundShells(raw);
    registerRawSession("c", raw);
    const agent = { id: "c", provider: "claude", session: facade("claude", raw) };
    raw.translateMessageToEvents({
      type: "system",
      subtype: "task_started",
      task_type: "local_bash",
      task_id: "b1",
    });
    expect(isAgentBusy(none, agent)).toBe(true);
    raw.translateMessageToEvents({ type: "system", subtype: "task_notification", task_id: "b1" });
    expect(isAgentBusy(none, agent)).toBe(false);
  });

  it("claude: a raw session that was never registered is busy", () => {
    const raw = fakeClaudeSession();
    trackClaudeBackgroundShells(raw);
    expect(isAgentBusy(none, { id: "c", provider: "claude", session: facade("claude", raw) })).toBe(
      true,
    );
  });
});
