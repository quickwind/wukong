// Irix edition: Claude gets the agent guide (agent-guide.ts) in its system prompt, and Paseo's MCP
// server only when the setting (agent-tools-setting.ts) says so at the moment its agent is created.
// Nothing shows in the chat. A resumed session keeps what its agent was created with
// (agent-tools-resume.ts).
//
// A new session gets the guide appended to `config.daemonAppendSystemPrompt`, which the agent
// manager sets afresh on every create. Both providers persist that field, which is how a resume
// finds out which mode the agent was made in.
//
// The hook sits on `ClaudeAgentClient.prototype`, so it sees the
// registry's real client whatever wraps it. It is installed when the provider registry is built
// (providers.ts), which comes before any session.

import { ClaudeAgentClient } from "../server/agent/providers/claude/agent.js";
import { withAgentGuide } from "./agent-guide.js";
import { getAgentToolsChannel } from "./agent-tools-setting.js";
import { type ResumeOverrides, withResumedAgentTools } from "./agent-tools-resume.js";
import { isIrixActive } from "./policy.js";

type SessionFactory = (this: unknown, ...args: unknown[]) => Promise<unknown>;

const HOOKED = Symbol("irix.claudeAgentGuide");
// Other Irix hooks may wrap ours later, which hides the marker, so a second install is refused here.
let installed = false;

function readAgentId(launchContext: unknown): string | undefined {
  if (!launchContext || typeof launchContext !== "object") {
    return undefined;
  }
  const agentId = (launchContext as { agentId?: unknown }).agentId;
  return typeof agentId === "string" ? agentId : undefined;
}

function hookCreate(): void {
  const target = ClaudeAgentClient.prototype as unknown as Record<string, unknown>;
  const original = target.createSession;
  if (typeof original !== "function" || (original as { [HOOKED]?: true })[HOOKED]) {
    return;
  }
  const factory = original as SessionFactory;
  const hooked: SessionFactory = function (this: unknown, ...args: unknown[]) {
    const next = [...args];
    next[0] = withAgentGuide(args[0] as ResumeOverrides | undefined, {
      provider: "claude",
      channel: getAgentToolsChannel(),
      agentId: readAgentId(args[1]),
    });
    return factory.apply(this, next);
  };
  Object.defineProperty(hooked, HOOKED, { value: true });
  target.createSession = hooked;
}

function hookResume(): void {
  const target = ClaudeAgentClient.prototype as unknown as Record<string, unknown>;
  const original = target.resumeSession;
  if (typeof original !== "function" || (original as { [HOOKED]?: true })[HOOKED]) {
    return;
  }
  const factory = original as SessionFactory;
  const hooked: SessionFactory = function (this: unknown, ...args: unknown[]) {
    const next = [...args];
    next[1] = withResumedAgentTools(
      args[0],
      args[1] as ResumeOverrides | undefined,
      readAgentId(args[2]),
    );
    return factory.apply(this, next);
  };
  Object.defineProperty(hooked, HOOKED, { value: true });
  target.resumeSession = hooked;
}

/** Idempotent; does nothing unless the Irix policy is active when it is called. */
export function installClaudeAgentGuide(): void {
  if (installed || !isIrixActive()) {
    return;
  }
  installed = true;
  // createSession(config, launchContext, options); resumeSession(handle, overrides, launchContext)
  hookCreate();
  hookResume();
}

/** Test seam: allow a new install (tests restore the prototype themselves). */
export function resetClaudeAgentGuideForTests(): void {
  installed = false;
}
