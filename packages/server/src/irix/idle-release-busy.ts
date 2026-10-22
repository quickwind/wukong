// Irix edition: "is this agent doing work the idle release must not interrupt?"
// Reads upstream private members (ACP `terminalEntries`, Claude `translateMessageToEvents`);
// every read tolerates absence, and idle-release-busy.test.ts pins the upstream source text so a
// rename fails a test instead of silently disabling the probe.

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

/** ACP: a terminal the provider created that has not been released and whose command has not exited. */
export function hasRunningAcpTerminal(session: unknown): boolean {
  const entries = asRecord(session)?.terminalEntries;
  if (!(entries instanceof Map)) {
    return false;
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
  runningShells.set(target, shells);
  target.translateMessageToEvents = function (this: unknown, message: unknown, ...rest: unknown[]) {
    try {
      observeTaskMessage(shells, message);
    } catch {
      // Tracking must never break message translation.
    }
    return (original as (...a: unknown[]) => unknown).call(this, message, ...rest);
  };
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

export function hasRunningClaudeBackgroundShell(session: unknown): boolean {
  const target = asRecord(session);
  return target ? (runningShells.get(target)?.size ?? 0) > 0 : false;
}

export function isAgentBusy(
  manager: { listProviderSubagents?(id: string): { status: string }[] },
  agent: { id: string; provider: string; session: unknown },
): boolean {
  try {
    const subagents = manager.listProviderSubagents?.(agent.id) ?? [];
    if (subagents.some((s) => s.status === "running")) {
      return true;
    }
  } catch {
    // Unknown agent or provider without subagents: not busy on this probe.
  }
  if (agent.provider === "devin") {
    return hasRunningAcpTerminal(agent.session);
  }
  if (agent.provider === "claude") {
    return hasRunningClaudeBackgroundShell(agent.session);
  }
  return false;
}
