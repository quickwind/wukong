// Irix edition: "is this agent doing work the idle release must not interrupt?"
// Reads upstream private members (ACP `terminalEntries`, Claude `translateMessageToEvents`) on the
// real provider session (idle-release-sessions.ts), never on the registry facade the manager holds.
// Every probe fails closed: a session it cannot resolve or inspect counts as busy.
// idle-release-busy.test.ts pins the upstream source text so a rename fails a test.

import { rawSessionFor } from "./idle-release-sessions.js";

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "killed",
  "stopped",
  "canceled",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * ACP: a terminal the provider created that has not been released and whose command has not
 * exited. Fails closed: a session without a `terminalEntries` Map cannot be inspected.
 */
export function hasRunningAcpTerminal(session: unknown): boolean {
  const entries = asRecord(session)?.terminalEntries;
  if (!(entries instanceof Map)) {
    return true;
  }
  for (const entry of entries.values()) {
    const e = asRecord(entry);
    if (e && e.released === false && e.exit === null) {
      return true;
    }
  }
  return false;
}

const runningShells = new WeakMap<object, Set<string>>();

/** Claude: watch system task messages on the session to know which background shells still run. */
export function trackClaudeBackgroundShells(session: unknown): void {
  const target = asRecord(session);
  if (!target || runningShells.has(target)) {
    return;
  }
  const original = target.translateMessageToEvents;
  if (typeof original !== "function") {
    return;
  }
  const shells = new Set<string>();
  target.translateMessageToEvents = function (this: unknown, message: unknown, ...rest: unknown[]) {
    try {
      observeTaskMessage(shells, message);
    } catch {
      // Tracking must never break message translation.
    }
    return (original as (...a: unknown[]) => unknown).call(this, message, ...rest);
  };
  // Only after the wrap took: a session that refused it (frozen) stays untracked, so busy.
  runningShells.set(target, shells);
}

function observeTaskMessage(shells: Set<string>, message: unknown): void {
  const m = asRecord(message);
  if (!m || m.type !== "system" || typeof m.task_id !== "string") {
    return;
  }
  switch (m.subtype) {
    case "task_started":
      if (m.task_type === "local_bash") {
        shells.add(m.task_id);
      }
      return;
    case "task_notification":
      shells.delete(m.task_id);
      return;
    case "task_updated": {
      const status = asRecord(m.patch)?.status;
      if (typeof status === "string" && TERMINAL_TASK_STATUSES.has(status)) {
        shells.delete(m.task_id);
      }
      return;
    }
  }
}

/**
 * Fails closed: a session the tracker never saw (its client was not wrapped, or the method moved)
 * counts as running a shell, so it stays resident instead of having a dev server killed.
 */
export function hasRunningClaudeBackgroundShell(session: unknown): boolean {
  const target = asRecord(session);
  const shells = target ? runningShells.get(target) : undefined;
  return shells === undefined || shells.size > 0;
}

export function isAgentBusy(
  manager: { listProviderSubagents?(id: string): { status: string }[] },
  agent: { id: string; provider: string; session?: unknown },
  logger?: { warn(fields: object, message: string): void },
): boolean {
  try {
    const subagents = manager.listProviderSubagents?.(agent.id) ?? [];
    if (subagents.some((s) => s.status === "running")) {
      return true;
    }
  } catch (error) {
    // Unknown state: keep the agent. The sweep probes each agent once per tick, so this warns
    // at most once per agent per tick.
    logger?.warn(
      { agentId: agent.id, provider: agent.provider, err: error },
      "irix.idle_release.subagent_probe_failed",
    );
    return true;
  }
  if (agent.provider !== "devin" && agent.provider !== "claude") {
    return false;
  }
  const raw = rawSessionFor(agent.id);
  if (raw === undefined) {
    // The sweep probes only agents that passed every other check, once per tick.
    logger?.warn(
      { agentId: agent.id, provider: agent.provider },
      "irix.idle_release.session_unresolved",
    );
    return true;
  }
  return agent.provider === "devin"
    ? hasRunningAcpTerminal(raw)
    : hasRunningClaudeBackgroundShell(raw);
}
