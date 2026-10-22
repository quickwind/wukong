// Which agents are in use right now, from the client heartbeats the ws server already tracks.
// The ws server's `sessions` map and `Session.getClientActivity` are upstream internals; they are
// read only here, and a rename fails idle-release-viewers.test.ts.

interface ClientActivityLike {
  appVisible?: boolean;
  focusedAgentId?: string | null;
  lastActivityAt?: Date;
}

let attached: unknown;

export function attachIdleReleaseWsServer(wsServer: unknown): void {
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
