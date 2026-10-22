// Irix edition: the provider session behind the registry facade, keyed by agent id.
// Upstream `wrapSessionProvider` (provider-registry.ts) hands the manager a plain object that only
// forwards the AgentSession interface, so the idle-release probes cannot read the real session's
// private members from `ManagedAgent.session`. The registry's inner clients are instances of
// `ClaudeAgentClient` and `ACPAgentClient` (Devin extends it and calls `super`), so patching those
// prototypes sees every real session, whichever client object the manager or registry holds.
// idle-release-sessions.test.ts pins the launch-context argument positions the hook reads.

import { ACPAgentClient } from "../server/agent/providers/acp-agent.js";
import { ClaudeAgentClient } from "../server/agent/providers/claude/agent.js";
import { trackClaudeBackgroundShells } from "./idle-release-busy.js";
import { isIrixActive } from "./policy.js";

const rawSessions = new Map<string, WeakRef<object>>();

function pruneDeadSessions(): void {
  for (const [agentId, ref] of rawSessions) {
    if (ref.deref() === undefined) {
      rawSessions.delete(agentId);
    }
  }
}

export function registerRawSession(agentId: string | undefined, session: object): void {
  if (!agentId) {
    return;
  }
  pruneDeadSessions();
  rawSessions.set(agentId, new WeakRef(session));
}

export function rawSessionFor(agentId: string): object | undefined {
  const ref = rawSessions.get(agentId);
  const session = ref?.deref();
  if (ref && session === undefined) {
    rawSessions.delete(agentId);
  }
  return session;
}

type SessionFactory = (this: unknown, ...args: unknown[]) => Promise<unknown>;

const HOOKED = Symbol("irix.idleRelease.sessionHook");
let installed = false;

function readAgentId(launchContext: unknown): string | undefined {
  if (!launchContext || typeof launchContext !== "object") {
    return undefined;
  }
  const agentId = (launchContext as { agentId?: unknown }).agentId;
  return typeof agentId === "string" ? agentId : undefined;
}

function hookFactory(
  prototype: object,
  method: "createSession" | "resumeSession",
  launchContextIndex: number,
  trackShells: boolean,
): void {
  const target = prototype as Record<string, unknown>;
  const original = target[method];
  if (typeof original !== "function" || (original as { [HOOKED]?: true })[HOOKED]) {
    return;
  }
  const factory = original as SessionFactory;
  const hooked: SessionFactory = async function (this: unknown, ...args: unknown[]) {
    const session = await factory.apply(this, args);
    if (session && typeof session === "object") {
      try {
        registerRawSession(readAgentId(args[launchContextIndex]), session);
      } catch {
        // A hook error must never fail session creation.
      }
      if (trackShells) {
        try {
          trackClaudeBackgroundShells(session);
        } catch {
          // An untracked Claude session counts as busy.
        }
      }
    }
    return session;
  };
  Object.defineProperty(hooked, HOOKED, { value: true });
  target[method] = hooked;
}

/** Idempotent; does nothing unless the Irix policy is active when it is called. */
export function installIdleReleaseSessionHooks(): void {
  if (installed || !isIrixActive()) {
    return;
  }
  installed = true;
  // createSession(config, launchContext, options); resumeSession(handle, overrides, launchContext)
  hookFactory(ClaudeAgentClient.prototype, "createSession", 1, true);
  hookFactory(ClaudeAgentClient.prototype, "resumeSession", 2, true);
  hookFactory(ACPAgentClient.prototype, "createSession", 1, false);
  hookFactory(ACPAgentClient.prototype, "resumeSession", 2, false);
}

/** Test seam: forget registered sessions and allow a new install (tests restore the prototypes). */
export function resetIdleReleaseSessionsForTests(): void {
  rawSessions.clear();
  installed = false;
}
