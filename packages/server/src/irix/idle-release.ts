// Irix edition: close the provider process of agents that sat idle past the configured time.
// The agent stays `closed` with its timeline; `ensureAgentLoaded` resumes it on the next open
// or prompt. Upstream `closeAgent` runs in the per-agent lifecycle lane and `ensureAgentLoaded`
// waits for an in-flight close, so a prompt racing a release lands on the resumed agent.
//
// Two-tick rule: an agent is closed only when the same session object was already releasable on
// the previous sweep. A resumed agent keeps its old `updatedAt` (upstream registers it with
// `restoring: true`), so without the rule a prompt that resumes a released agent could see it
// closed again between `ensureAgentLoaded` and `startAgentRun`.

import { isIrixActive } from "./policy.js";
import { type IdleReleaseSettings, getIdleReleaseSettings } from "./idle-release-settings.js";

export const RELEASABLE_PROVIDERS: ReadonlySet<string> = new Set(["claude", "devin"]);

const SWEEP_INTERVAL_MS = 60_000;
const MINUTE_MS = 60_000;

export interface ManagedAgentLike {
  id: string;
  provider: string;
  lifecycle: string;
  activeForegroundTurnId: string | null;
  pendingPermissions: { size: number };
  internal?: boolean;
  updatedAt: Date;
  /** Provider session. A new object means a new process, which restarts the two-tick count. */
  session?: unknown;
}

export interface IdleReleaseManager {
  listAgents(): ManagedAgentLike[];
  closeAgent(id: string): Promise<void>;
  listProviderSubagents?(id: string): { status: string }[];
}

export interface IdleReleaseLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface IdleReleaseDeps {
  now?: () => number;
  intervalMs?: number;
  isBusy?: (agent: ManagedAgentLike) => boolean;
  viewed?: (now: number, minutes: number) => ReadonlySet<string>;
  logger?: IdleReleaseLogger;
}

export interface IdleReleaseContext {
  now: number;
  settings: IdleReleaseSettings;
  viewed: ReadonlySet<string>;
  busy: boolean;
}

export function isReleasable(agent: ManagedAgentLike, ctx: IdleReleaseContext): boolean {
  if (!ctx.settings.enabled) return false;
  if (!RELEASABLE_PROVIDERS.has(agent.provider)) return false;
  if (agent.internal === true) return false;
  if (agent.lifecycle !== "idle") return false;
  if (agent.activeForegroundTurnId) return false;
  if (agent.pendingPermissions.size > 0) return false;
  if (ctx.now - agent.updatedAt.getTime() < ctx.settings.minutes * MINUTE_MS) return false;
  if (ctx.viewed.has(agent.id)) return false;
  return !ctx.busy;
}

/** Agents found releasable on the previous sweep, keyed by id, with the session seen then. */
export interface IdleReleaseSweepState {
  candidates: Map<string, unknown>;
}

export function createIdleReleaseSweepState(): IdleReleaseSweepState {
  return { candidates: new Map() };
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const noopLogger: IdleReleaseLogger = { info: () => undefined, warn: () => undefined };

/**
 * One sweep. Releases agents one at a time; a failed close is logged and retried next sweep.
 * `state` carries the previous sweep's candidates; pass the same object to consecutive sweeps.
 */
export async function sweepOnce(
  manager: IdleReleaseManager,
  deps: IdleReleaseDeps = {},
  state: IdleReleaseSweepState = createIdleReleaseSweepState(),
): Promise<void> {
  if (!isIrixActive()) {
    state.candidates = new Map();
    return;
  }
  const settings = getIdleReleaseSettings();
  if (!settings.enabled) {
    state.candidates = new Map();
    return;
  }
  const clock = deps.now ?? Date.now;
  const isBusy = deps.isBusy ?? (() => false);
  const logger = deps.logger ?? noopLogger;
  const previous = state.candidates;
  const next = new Map<string, unknown>();

  try {
    const agentIds = manager.listAgents().map((agent) => agent.id);
    for (const agentId of agentIds) {
      // Re-read the agent and the viewers right before closing: an earlier close awaited, so a
      // prompt may have started a turn, or a client focused this agent, since the list was
      // taken. Decision and `closeAgent` stay synchronous so nothing can start between them.
      const agent = manager.listAgents().find((entry) => entry.id === agentId);
      if (!agent) continue;
      const now = clock();
      const viewed = deps.viewed?.(now, settings.minutes) ?? EMPTY_SET;
      if (!isReleasable(agent, { now, settings, viewed, busy: isBusy(agent) })) continue;
      if (!previous.has(agentId) || previous.get(agentId) !== agent.session) {
        next.set(agentId, agent.session);
        continue;
      }
      const idleMinutes = Math.floor((now - agent.updatedAt.getTime()) / MINUTE_MS);
      try {
        await manager.closeAgent(agentId);
        logger.info(
          { agentId, provider: agent.provider, idleMinutes },
          "irix.idle_release.released",
        );
      } catch (error) {
        // Still releasable with the same session: retry on the next sweep.
        next.set(agentId, agent.session);
        logger.warn(
          { agentId, provider: agent.provider, err: error },
          "irix.idle_release.close_failed",
        );
      }
    }
  } finally {
    state.candidates = next;
  }
}

const running = new WeakMap<IdleReleaseManager, () => void>();

/** Starts the periodic sweep for this manager (once per manager). Returns stop. */
export function startIdleRelease(
  manager: IdleReleaseManager,
  deps: IdleReleaseDeps = {},
): () => void {
  if (!isIrixActive()) return () => undefined;
  const existing = running.get(manager);
  if (existing) return existing;

  let sweeping = false;
  const state = createIdleReleaseSweepState();
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweepOnce(manager, deps, state)
      .catch((error: unknown) => {
        deps.logger?.warn({ err: error }, "irix.idle_release.sweep_failed");
      })
      .finally(() => {
        sweeping = false;
      });
  }, deps.intervalMs ?? SWEEP_INTERVAL_MS);
  timer.unref?.();

  const stop = () => {
    clearInterval(timer);
    if (running.get(manager) === stop) running.delete(manager);
  };
  running.set(manager, stop);
  return stop;
}
