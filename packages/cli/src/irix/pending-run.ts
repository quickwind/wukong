// Irix: a run that waits for a human can outlast the shell tool of the agent that started it
// (Devin's gives up after 30 s, Claude's moves a command to the background after 120 s). So an
// agent's `irix run` waits one short window, then exits and says so; the daemon keeps the request
// and its approval card open for ten minutes under an idempotency key, and the same command run
// again picks it up. This file keeps that key between the two runs: a repeat of the same request
// reuses it for ten minutes, and a request that has an outcome (an agent, or a refusal) forgets it,
// so a deliberate second run later is a new request.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PENDING_RUN_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_APPROVAL_WINDOW_MS = 20_000;

interface PendingRunRecord {
  key: string;
  startedAt: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, entry]) => [name, canonical(entry)]),
    );
  }
  return value;
}

/** Names one request: the calling agent and everything the run asks for. */
export function fingerprintRun(callerAgentId: string, request: Record<string, unknown>): string {
  const { requestId: _requestId, onEvent: _onEvent, idempotencyKey: _key, ...intent } = request;
  return createHash("sha256")
    .update(JSON.stringify(canonical([callerAgentId, intent])))
    .digest("hex")
    .slice(0, 32);
}

function recordPath(home: string, fingerprint: string): string {
  return path.join(home, "pending-runs", `${fingerprint}.json`);
}

export function irixHomeForPendingRuns(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_HOME?.trim() || path.join(os.homedir(), ".irix");
}

/** The key of the earlier unfinished attempt at this request, or a new one. */
export function pendingRunKey(
  home: string,
  fingerprint: string,
  now: number = Date.now(),
): { key: string; resumed: boolean } {
  const file = recordPath(home, fingerprint);
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as PendingRunRecord;
    if (typeof record.key === "string" && now - record.startedAt < PENDING_RUN_TTL_MS) {
      return { key: record.key, resumed: true };
    }
  } catch {
    // No earlier attempt, or an unreadable record: start a new one.
  }
  const record: PendingRunRecord = { key: `irix-run-${randomUUID()}`, startedAt: now };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record));
  return { key: record.key, resumed: false };
}

export function clearPendingRun(home: string, fingerprint: string): void {
  rmSync(recordPath(home, fingerprint), { force: true });
}
