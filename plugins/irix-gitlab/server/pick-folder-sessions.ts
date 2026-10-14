import { randomUUID } from "node:crypto";

export interface PickFolderPoll {
  state: "pending" | "done" | "failed";
  path: string | null;
  error: string | null;
}

interface Session extends PickFolderPoll {
  startedAt: number;
}

const RETAIN_MS = 15 * 60 * 1000;

/**
 * Runs the folder dialog in the background and hands out its result by id. Only one dialog is open
 * at a time: asking again while one is open returns the same id instead of stacking another.
 */
export function createFolderPickerSessions(
  pick: (title?: string) => Promise<string | null>,
  now: () => number = Date.now,
) {
  const sessions = new Map<string, Session>();
  let openId: string | null = null;

  function prune(): void {
    for (const [id, session] of sessions) {
      if (session.state !== "pending" && now() - session.startedAt > RETAIN_MS) sessions.delete(id);
    }
  }

  return {
    start(title?: string): string {
      prune();
      if (openId && sessions.get(openId)?.state === "pending") return openId;
      const id = randomUUID();
      const session: Session = { state: "pending", path: null, error: null, startedAt: now() };
      sessions.set(id, session);
      openId = id;
      void (async () => {
        try {
          session.path = await pick(title);
          session.state = "done";
        } catch (error) {
          session.error = error instanceof Error ? error.message : String(error);
          session.state = "failed";
        }
      })();
      return id;
    },

    poll(id: string): PickFolderPoll {
      const session = sessions.get(id);
      if (!session) {
        return { state: "failed", path: null, error: "That folder dialog is no longer available" };
      }
      if (session.state !== "pending") sessions.delete(id);
      return { state: session.state, path: session.path, error: session.error };
    },
  };
}
