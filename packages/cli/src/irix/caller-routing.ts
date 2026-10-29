// Irix: routes the requests that can start an agent so the daemon can ask the calling agent for
// approval. Hooked where the client sends session requests, on the connection the command already
// has, because upstream builds these messages from fixed options:
// - agent creation (`irix run`, `irix agent run`, a workspace with an agent): `run` already names a
//   caller the daemon knows. Inside an agent's shell (PASEO_AGENT_ID set) a creation that names none
//   is refused here when the daemon requires approval, because no card could reach anyone.
// - the four `schedule/*` requests that can start an agent: the caller is checked with the daemon
//   and named, and the request waits without a deadline, since the approval can take ten minutes.
//   An unknown caller is refused the same way.
// The id is a routing signal: the daemon decides whether to ask.

import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resolveCallerAgentId } from "../utils/caller-agent.js";
import {
  clearPendingRun,
  DEFAULT_APPROVAL_WINDOW_MS,
  fingerprintRun,
  irixHomeForPendingRuns,
  pendingRunKey,
} from "./pending-run.js";

const AGENT_CREATION_MESSAGES: ReadonlySet<string> = new Set([
  "agent.create.request",
  "create_agent_request",
]);

const SCHEDULE_MESSAGES: ReadonlySet<string> = new Set([
  "schedule/create",
  "schedule/resume",
  "schedule/run-once",
  "schedule/update",
]);

interface SessionRequestParams {
  message: { type: string } & Record<string, unknown>;
  timeout?: number;
}

type SendFn = (this: unknown, params: SessionRequestParams) => Promise<unknown>;

interface ClientInternals {
  lastServerInfoMessage?: { features?: Record<string, unknown> } | null;
  fetchAgent(options: { agentId: string }): Promise<{ agent: { id: string } } | null>;
}

function startsAgent(message: SessionRequestParams["message"]): boolean {
  return (
    AGENT_CREATION_MESSAGES.has(message.type) ||
    (message.type === "workspace.create.request" && message.agent !== undefined)
  );
}

function namesCaller(message: SessionRequestParams["message"]): boolean {
  const agent = message.agent as { callerAgentId?: unknown } | undefined;
  return typeof message.callerAgentId === "string" || typeof agent?.callerAgentId === "string";
}

// One lookup per connection, shared by every request on it.
const verifiedCallers = new WeakMap<object, Promise<string | undefined>>();

function verifiedCaller(
  client: ClientInternals,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  let pending = verifiedCallers.get(client);
  if (!pending) {
    pending = resolveCallerAgentId(client, env);
    verifiedCallers.set(client, pending);
  }
  return pending;
}

function approvalUnavailable(): { code: string; message: string } {
  return {
    code: "SUBAGENT_APPROVAL_UNAVAILABLE",
    message:
      "Subagent approval is required, but this daemon does not know the agent in PASEO_AGENT_ID, so no approval card can be shown. Run from a live agent, or unset PASEO_AGENT_ID in a terminal.",
  };
}

function approvalPending(): { code: string; message: string } {
  return {
    code: "SUBAGENT_APPROVAL_PENDING",
    message:
      "Subagent creation is waiting for a human to approve it (the approval card is in this agent's chat). The request stays open for 10 minutes. Run exactly the same command again to keep waiting; do not change its arguments and do not start the work yourself.",
  };
}

type CreateAgentFn = (this: unknown, options: Record<string, unknown>) => Promise<unknown>;

/**
 * An agent's shell tool may give up on a command long before a person answers, so `irix run` waits
 * one window and then exits. The request keeps its idempotency key (see `pending-run.ts`), the
 * daemon keeps the approval open, and running the command again picks the same request up.
 */
function wrapCreateAgent(original: CreateAgentFn, env: NodeJS.ProcessEnv): CreateAgentFn {
  return async function createWithinWindow(this: unknown, options) {
    const client = this as ClientInternals;
    const callerAgentId = typeof options.callerAgentId === "string" ? options.callerAgentId : "";
    const required = client.lastServerInfoMessage?.features?.requireSubagentApproval === true;
    if (!env.PASEO_AGENT_ID?.trim() || !callerAgentId || !required) {
      return original.call(this, options);
    }
    const home = irixHomeForPendingRuns(env);
    const fingerprint = fingerprintRun(callerAgentId, options);
    const { key } = pendingRunKey(home, fingerprint);
    const windowMs = Number(env.IRIX_APPROVAL_WINDOW_MS) || DEFAULT_APPROVAL_WINDOW_MS;

    const settled = original.call(this, { ...options, idempotencyKey: key }).then(
      (value) => ({ done: true as const, value }),
      (error: unknown) => ({ done: true as const, error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<{ done: false }>((resolve) => {
      timer = setTimeout(() => resolve({ done: false }), windowMs);
    });
    const outcome = await Promise.race([settled, expired]);
    clearTimeout(timer);
    if (!outcome.done) {
      throw approvalPending();
    }
    clearPendingRun(home, fingerprint);
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  };
}

let installed = false;

export function installCallerRouting(env: NodeJS.ProcessEnv = process.env): void {
  const prototype = DaemonClient.prototype as unknown as {
    sendCorrelatedSessionRequest?: SendFn;
    createAgent?: CreateAgentFn;
  };
  const original = prototype.sendCorrelatedSessionRequest;
  if (installed || typeof original !== "function") {
    return;
  }
  installed = true;
  if (typeof prototype.createAgent === "function") {
    prototype.createAgent = wrapCreateAgent(prototype.createAgent, env);
  }
  prototype.sendCorrelatedSessionRequest = async function withCaller(this: unknown, params) {
    const message = params.message;
    if (!env.PASEO_AGENT_ID?.trim()) {
      return original.call(this, params);
    }
    const client = this as ClientInternals;
    const required = client.lastServerInfoMessage?.features?.requireSubagentApproval === true;
    if (startsAgent(message)) {
      if (required && !namesCaller(message)) {
        throw approvalUnavailable();
      }
      return original.call(this, params);
    }
    if (!SCHEDULE_MESSAGES.has(message.type)) {
      return original.call(this, params);
    }
    const callerAgentId = await verifiedCaller(client, env);
    if (!callerAgentId) {
      if (required) {
        throw approvalUnavailable();
      }
      return original.call(this, params);
    }
    return original.call(this, { ...params, timeout: 0, message: { ...message, callerAgentId } });
  };
}
