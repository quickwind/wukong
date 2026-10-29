// Which agents are in use right now, from the client heartbeats the ws server already tracks.
// Upstream's idle collector (bootstrap.ts `isProtected`) asks `isIrixAgentViewed` so an agent a
// person has open and focused is kept. The ws server's `sessions` map and
// `Session.getClientActivity` are upstream internals; they are read only here, and a rename fails
// idle-viewers.test.ts.

interface ClientActivityLike {
  appVisible?: boolean;
  focusedAgentId?: string | null;
  lastActivityAt?: Date;
}

import { isIrixActive } from "./policy.js";

let attached: unknown;

export function attachIdleViewers(wsServer: unknown): void {
  attached = wsServer;
}

function clientActivities(): ClientActivityLike[] {
  const sessions = (attached as { sessions?: unknown } | null | undefined)?.sessions;
  if (!(sessions instanceof Map)) return [];
  const result: ClientActivityLike[] = [];
  for (const [ws, connection] of sessions) {
    const session = (connection as { session?: { getClientActivity?: unknown } } | null)?.session;
    if (typeof session?.getClientActivity !== "function") continue;
    const value = (session.getClientActivity as (source: unknown) => unknown).call(session, ws);
    if (value) result.push(value as ClientActivityLike);
  }
  return result;
}

export function viewedAgentIds(now: number, minutes: number): ReadonlySet<string> {
  const viewed = new Set<string>();
  for (const activity of clientActivities()) {
    const at = activity.lastActivityAt?.getTime();
    if (
      activity.appVisible === true &&
      typeof activity.focusedAgentId === "string" &&
      typeof at === "number" &&
      now - at < minutes * 60_000
    ) {
      viewed.add(activity.focusedAgentId);
    }
  }
  return viewed;
}

const DEFAULT_IDLE_MINUTES = 15;
const MAX_IDLE_MINUTES = 1440;

/** Idle time before upstream's collector releases a runtime; `IRIX_IDLE_MINUTES` (1 to 1440) sets it. */
export function irixIdleMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.IRIX_IDLE_MINUTES);
  return Number.isInteger(value) && value >= 1 && value <= MAX_IDLE_MINUTES
    ? value
    : DEFAULT_IDLE_MINUTES;
}

/** Whether a client has this agent open, focused and recently active. Always false outside Irix. */
export function isIrixAgentViewed(agentId: string, now: number = Date.now()): boolean {
  return isIrixActive() && viewedAgentIds(now, irixIdleMinutes()).has(agentId);
}

/** Upstream's idle period in milliseconds, or Irix's when the edition is active. */
export function irixIdlePeriodMs(upstreamMs: number): number {
  return isIrixActive() ? irixIdleMinutes() * 60_000 : upstreamMs;
}
