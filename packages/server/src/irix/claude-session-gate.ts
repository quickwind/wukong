// Irix edition: puts the subagent approval hook on Claude's real session.
// Upstream `wrapSessionProvider` (provider-registry.ts) hands the manager a plain object that only
// forwards the AgentSession interface, so a hook cannot be added to the session from the manager's
// side. The registry's inner client is an instance of `ClaudeAgentClient`, so patching its
// prototype reaches every real session, whichever client object the manager or registry holds.

import { ClaudeAgentClient } from "../server/agent/providers/claude/agent.js";
import { isIrixActive } from "./policy.js";
import { attachClaudeSessionSubagentGate } from "./subagent-approval.js";

type SessionFactory = (this: unknown, ...args: unknown[]) => Promise<unknown>;

const HOOKED = Symbol("irix.claudeSessionGate");
let installed = false;

function hookFactory(method: "createSession" | "resumeSession"): void {
  const target = ClaudeAgentClient.prototype as unknown as Record<string, unknown>;
  const original = target[method];
  if (typeof original !== "function" || (original as { [HOOKED]?: true })[HOOKED]) {
    return;
  }
  const factory = original as SessionFactory;
  const hooked: SessionFactory = async function (this: unknown, ...args: unknown[]) {
    const session = await factory.apply(this, args);
    if (session && typeof session === "object") {
      try {
        attachClaudeSessionSubagentGate(session as Record<string, unknown>);
      } catch {
        // A hook error must never fail session creation.
      }
    }
    return session;
  };
  Object.defineProperty(hooked, HOOKED, { value: true });
  target[method] = hooked;
}

/** Idempotent; does nothing unless the Irix policy is active when it is called. */
export function installClaudeSessionGate(): void {
  if (installed || !isIrixActive()) {
    return;
  }
  installed = true;
  hookFactory("createSession");
  hookFactory("resumeSession");
}

/** Test seam: allow a new install (tests restore the prototype). */
export function resetClaudeSessionGateForTests(): void {
  installed = false;
}
