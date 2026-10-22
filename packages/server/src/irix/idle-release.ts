// Irix edition: close the provider process of agents that sat idle past the configured time.
// The agent stays `closed` with its timeline; `ensureAgentLoaded` resumes it on the next open
// or prompt. Upstream `closeAgent` runs in the per-agent lifecycle lane and `ensureAgentLoaded`
// waits for an in-flight close, so a prompt racing a release lands on the resumed agent.

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

const EMPTY_SET: ReadonlySet<string> = new Set();
const noopLogger: IdleReleaseLogger = { info: () => undefined, warn: () => undefined };

/** One sweep. Releases agents one at a time; a failed close is logged and retried next sweep. */
export async function sweepOnce(
  manager: IdleReleaseManager,
  deps: IdleReleaseDeps = {},
): Promise<void> {
  if (!isIrixActive()) return;
  const settings = getIdleReleaseSettings();
  if (!settings.enabled) return;
  const clock = deps.now ?? Date.now;
  const isBusy = deps.isBusy ?? (() => false);
  const logger = deps.logger ?? noopLogger;
  const viewed = deps.viewed?.(clock(), settings.minutes) ?? EMPTY_SET;

  const candidateIds = manager.listAgents().map((agent) => agent.id);
  for (const agentId of candidateIds) {
    // Re-read the agent right before closing: an earlier close awaited, so a prompt may have
    // started a turn since the list was taken. Decision and `closeAgent` stay synchronous so
    // nothing can start between them.
    const agent = manager.listAgents().find((entry) => entry.id === agentId);
    if (!agent) continue;
    const now = clock();
    if (!isReleasable(agent, { now, settings, viewed, busy: isBusy(agent) })) continue;
    const idleMinutes = Math.floor((now - agent.updatedAt.getTime()) / MINUTE_MS);
    try {
      await manager.closeAgent(agentId);
      logger.info({ agentId, provider: agent.provider, idleMinutes }, "irix.idle_release.released");
    } catch (error) {
      logger.warn(
        { agentId, provider: agent.provider, err: error },
        "irix.idle_release.close_failed",
      );
    }
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
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweepOnce(manager, deps)
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
