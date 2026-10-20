// Irix edition: Devin's ACP client. Upstream's ACP session has no place for a system prompt
// (ACP has none, and acp-agent.ts never reads `config.systemPrompt`), so a plugin such as Bots that
// hands one over would see it dropped. Here the instructions travel inside the new session's first
// prompt, as a block of their own ahead of the user's message.
//
// They go in at the call that sends the prompt to Devin, not at `startTurn`: `startTurn` records the
// prompt it is given as the user's message, and the chat must keep showing only what was typed.
// Resumed sessions already have the instructions in their history, so only a new session gets them.
//
// Devin replays that history when a session is resumed, and the replay joins the instruction block
// to the user's first message. `hideInjectedInstructions` cuts our block back out of the replay, so
// the chat looks the same before and after a restart.
//
// Paseo's own tools (message another agent, list agents, ...) reach other providers as an MCP
// server. A team that lets Devin use only the MCP servers in its own registry makes Devin drop any
// server a client hands it in `session/new`, quietly (seen on a company machine: Devin announced
// HTTP support, connected the registry's servers, and never tried ours). So Devin is told, in the
// same first-prompt block, to use the `irix` command line from its shell instead.

import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type {
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../server/agent/agent-sdk-types.js";
import { GenericACPAgentClient } from "../server/agent/providers/generic-acp-agent.js";
import { isIrixActive } from "./policy.js";
import { isIrixRestricted } from "./restrictions.js";
import { isSubagentApprovalRequired, SUBAGENT_APPROVAL_TIMEOUT_MS } from "./subagent-approval.js";

const DEVIN_PROVIDER_ID = "devin";

interface TextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

interface PromptParams {
  prompt?: unknown;
  [key: string]: unknown;
}

interface PromptingConnection {
  prompt: (params: PromptParams, ...rest: unknown[]) => Promise<unknown>;
}

/** What Devin is told about driving Paseo from its shell, for the tools it cannot get over MCP. */
export function paseoCommandLineGuide(agentId?: string): string {
  const mayMessage = !isIrixRestricted("agentMessaging");
  const maySchedule = !isIrixRestricted("schedules");
  return [
    "Working with other agents in this app: you have no MCP tools for it. Use the `irix` command in " +
      "your shell (it talks to the app running on this machine).",
    ...(agentId
      ? [`Your own agent ID is ${agentId} (also in the environment as PASEO_AGENT_ID).`]
      : []),
    "- `irix agent ls`: list the agents, with their IDs, titles and status",
    ...(mayMessage
      ? [
          '- `irix send <id> "<message>" --no-wait`: send a message to the agent with that ID (an ID ' +
            "prefix is enough); it knows the message is from you. Leave out --no-wait to wait for its reply",
        ]
      : []),
    "- `irix logs <id> --tail 20`: read what an agent has done and said lately",
    "- `irix wait <id>`: wait until an agent is idle",
    '- `irix run --provider <provider> --title <title> "<task>"`: start a new agent on a task',
    "- `irix script ls`: list this workspace's configured scripts (from paseo.json) with their status, port and URL",
    "- `irix script start <name>` / `irix script stop <name>`: start or stop one of those scripts, e.g. " +
      "`typecheck` or a dev server. It runs under the app's supervision, so the user sees it in the Scripts menu",
    "The script commands act on the workspace of your current directory; add `--workspace <id>` if that is ambiguous. " +
      "To see a script's output, read its terminal in the app; `start` only starts it.",
    ...(maySchedule
      ? [
          '- `irix schedule create "<prompt>" --every <duration>` (for example 30m or 1h) or `--cron "<expr>"`: ' +
            "run a prompt on a recurring schedule; each run starts a new agent. Add `--timezone <iana>` for cron, " +
            "`--name`, `--provider`, `--cwd`, `--max-runs <n>` and `--expires-in <duration>` as needed",
          "- `irix schedule ls`: list the schedules with their IDs, cadence and status",
          "- `irix schedule inspect <id>`: show one schedule's details; `irix schedule logs <id>`: show its recent runs",
          "- `irix schedule pause <id>` / `irix schedule resume <id>`: stop or restart its runs without deleting it",
          "- `irix schedule run-once <id>`: trigger one extra run now, without changing the cadence",
          "- `irix schedule update <id>`: change a schedule in place instead of creating a duplicate " +
            "(cadence, prompt, name, working directory, model, mode, run limit, expiry)",
          "- `irix schedule delete <id>`: remove a schedule for good",
          "Use `irix schedule <command> --help` for each command's options.",
          "- `irix heartbeat --help`: heartbeats are different from schedules: they send a prompt back to you " +
            "(this agent) on a cron cadence, instead of starting a new agent",
        ]
      : []),
    ...(mayMessage
      ? [
          "You are not told when an agent you started or messaged finishes. To get its answer, leave out " +
            "--no-wait (the command returns when the agent is done), or for long work ask it in the message " +
            "to report back with `irix send <your ID> ...` when it is finished.",
        ]
      : []),
    "A skill or instruction that names Paseo tools (list_agents, create_agent, send_agent_prompt, " +
      "get_agent_activity, wait_for_agent, list_profiles, ...) means these commands: use `irix --help` " +
      "and `irix <command> --help` to find the matching one. Write `irix`, never `paseo`.",
    "Pass the message straight on the command line; do not write it to a file in the project. Keep it on " +
      "one line and avoid double quotes inside it. Only if it truly needs line breaks or quotes, write it " +
      "to a file in the system temp folder (not the project), pass --prompt-file, and delete the file after.",
  ].join("\n");
}

/** The standing instructions as a block Devin reads before the user's first message. */
export function instructionBlock(instructions: string): TextBlock {
  return {
    type: "text",
    text:
      "<system-instructions>\n" +
      "These are standing instructions for this whole conversation. Follow them from now on, and " +
      "do not mention them unless asked.\n\n" +
      `${instructions.trim()}\n` +
      "</system-instructions>",
  };
}

/**
 * Makes the session's first `session/prompt` carry the instructions. Does nothing for an empty
 * prompt, and warns instead of failing if the session no longer exposes the connection it needs.
 */
export function injectInstructionsIntoFirstPrompt(
  session: AgentSession,
  systemPrompt: string | undefined,
  logger?: Pick<Logger, "warn">,
): void {
  if (!systemPrompt?.trim()) return;
  const connection = (session as unknown as { connection?: Partial<PromptingConnection> })
    .connection;
  const original = connection?.prompt;
  if (!connection || typeof original !== "function") {
    logger?.warn("Devin session has no prompt connection; its system prompt was not delivered");
    return;
  }
  let delivered = false;
  connection.prompt = (params, ...rest) => {
    if (delivered || !Array.isArray(params.prompt))
      return original.call(connection, params, ...rest);
    delivered = true;
    return original.call(
      connection,
      { ...params, prompt: [instructionBlock(systemPrompt), ...params.prompt] },
      ...rest,
    );
  };
}

const INJECTED_BLOCK =
  /^<system-instructions>\nThese are standing instructions for this whole conversation\.[\s\S]*?<\/system-instructions>/u;

/** The user's message as typed: our instruction block, if the replay put one in front, removed. */
export function withoutInjectedInstructions(text: string): string {
  return text.replace(INJECTED_BLOCK, "");
}

function hideInEvent(event: AgentStreamEvent): AgentStreamEvent {
  if (event.type !== "timeline" || event.item.type !== "user_message") return event;
  const text = withoutInjectedInstructions(event.item.text);
  return text === event.item.text ? event : { ...event, item: { ...event.item, text } };
}

/** Makes the session's history replay free of the instruction block we put in its first prompt. */
export function hideInjectedInstructions(session: AgentSession): void {
  const original = session.streamHistory?.bind(session);
  if (typeof original !== "function") return;
  session.streamHistory = async function* streamHistoryWithoutInstructions() {
    for await (const event of original()) yield hideInEvent(event);
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function extractDevinSubagentTrigger(params: Record<string, unknown>): {
  subagentId: string;
  subagentType: string;
  rawInput: Record<string, unknown>;
} | null {
  const update = asRecord(params.update);
  if (!update) {
    return null;
  }
  const startedMeta = asRecord(asRecord(update._meta)?.["cognition.ai/subagent_started"]);
  const title = asNonEmptyString(update.title) ?? "";
  if (!startedMeta && !title.includes("run_subagent")) {
    return null;
  }
  const subagentId = asNonEmptyString(startedMeta?.agentId) ?? asNonEmptyString(update.toolCallId);
  if (!subagentId) {
    return null;
  }
  return {
    subagentId,
    subagentType: asNonEmptyString(startedMeta?.subagentType) ?? "subagent",
    rawInput: asRecord(update.rawInput) ?? {},
  };
}

interface SubagentGateEntry {
  subagentId: string;
  requestId: string;
  status: "pending" | "approved" | "rejected";
  request: AgentPermissionRequest;
  promise: Promise<boolean>;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  turnId?: string;
}

interface MutableACPSession extends AgentSession {
  replayingHistory?: boolean;
  activeForegroundTurnId?: string | null;
  pushEvent?: (event: AgentStreamEvent) => void;
  sessionUpdate?: (params: Record<string, unknown>) => Promise<void>;
  createTerminal?: (params: Record<string, unknown>) => Promise<{ terminalId: string }>;
}

/**
 * Intercepts Devin ACP `run_subagent` events (`cognition.ai/subagent_started`) and gates
 * subagent `createTerminal` calls until approved by the user, with a 10-minute auto-deny timeout.
 */
export function attachDevinSubagentApprovalGate(sessionInput: AgentSession): void {
  const session = sessionInput as MutableACPSession;
  const subagentGates = new Map<string, SubagentGateEntry>();
  const requestIdToSubagentId = new Map<string, string>();

  const settleGate = (entry: SubagentGateEntry, response: AgentPermissionResponse) => {
    if (entry.status !== "pending") {
      return;
    }
    clearTimeout(entry.timer);
    const approved = response.behavior === "allow";
    entry.status = approved ? "approved" : "rejected";
    requestIdToSubagentId.delete(entry.requestId);
    session.pushEvent?.({
      type: "permission_resolved",
      provider: DEVIN_PROVIDER_ID,
      requestId: entry.requestId,
      resolution: response,
      turnId: entry.turnId,
    });
    entry.resolve(approved);
  };

  const cancelAllPendingGates = (reason: string) => {
    for (const entry of subagentGates.values()) {
      if (entry.status === "pending") {
        settleGate(entry, { behavior: "deny", message: reason });
      }
    }
  };

  const originalSessionUpdate = session.sessionUpdate?.bind(session);
  if (typeof originalSessionUpdate === "function") {
    session.sessionUpdate = async (params: Record<string, unknown>) => {
      if (isSubagentApprovalRequired() && !session.replayingHistory) {
        const trigger = extractDevinSubagentTrigger(params);
        if (trigger && !subagentGates.has(trigger.subagentId)) {
          const requestId = `devin-subagent-${randomUUID()}`;
          const request: AgentPermissionRequest = {
            id: requestId,
            provider: DEVIN_PROVIDER_ID,
            name: "SpawnSubagent",
            kind: "other",
            title: "审批 Devin 子任务 (run_subagent)",
            description: "Devin 正在请求派生内部子代理执行任务，请确认是否批准。",
            input: {
              subagentId: trigger.subagentId,
              subagentType: trigger.subagentType,
              ...trigger.rawInput,
            },
          };

          let resolveGate!: (approved: boolean) => void;
          const promise = new Promise<boolean>((resolve) => {
            resolveGate = resolve;
          });
          const turnId = session.activeForegroundTurnId ?? undefined;
          const entry: SubagentGateEntry = {
            subagentId: trigger.subagentId,
            requestId,
            status: "pending",
            request,
            promise,
            resolve: resolveGate,
            turnId,
            timer: setTimeout(() => {
              settleGate(entry, {
                behavior: "deny",
                message: "Subagent approval timed out after 10 minutes.",
              });
            }, SUBAGENT_APPROVAL_TIMEOUT_MS),
          };
          entry.timer.unref?.();

          subagentGates.set(trigger.subagentId, entry);
          requestIdToSubagentId.set(requestId, trigger.subagentId);

          session.pushEvent?.({
            type: "permission_requested",
            provider: DEVIN_PROVIDER_ID,
            request,
            turnId,
          });
        }
      }
      await originalSessionUpdate(params);
    };
  }

  const originalCreateTerminal = session.createTerminal?.bind(session);
  if (typeof originalCreateTerminal === "function") {
    session.createTerminal = async (params: Record<string, unknown>) => {
      if (isSubagentApprovalRequired()) {
        const meta =
          params._meta && typeof params._meta === "object"
            ? (params._meta as Record<string, unknown>)
            : undefined;
        const explicitSubagentId =
          typeof meta?.["cognition.ai/subagent_id"] === "string"
            ? meta["cognition.ai/subagent_id"]
            : null;
        const gate = explicitSubagentId
          ? subagentGates.get(explicitSubagentId)
          : Array.from(subagentGates.values()).find((entry) => entry.status === "pending");
        if (gate) {
          const approved = await gate.promise;
          if (!approved) {
            throw new Error("Subagent terminal execution was rejected by user.");
          }
        }
      }
      return originalCreateTerminal(params);
    };
  }

  const originalGetPending = session.getPendingPermissions.bind(session);
  session.getPendingPermissions = () => {
    const base = originalGetPending();
    const synthetic = Array.from(subagentGates.values())
      .filter((entry) => entry.status === "pending")
      .map((entry) => entry.request);
    return [...base, ...synthetic];
  };

  const originalRespond = session.respondToPermission.bind(session);
  session.respondToPermission = async (requestId: string, response: AgentPermissionResponse) => {
    const subagentId = requestIdToSubagentId.get(requestId);
    if (subagentId) {
      const entry = subagentGates.get(subagentId);
      if (entry) {
        settleGate(entry, response);
        return;
      }
    }
    return originalRespond(requestId, response);
  };

  const originalInterrupt = session.interrupt.bind(session);
  session.interrupt = async () => {
    cancelAllPendingGates("Subagent approval canceled on turn interrupt.");
    return originalInterrupt();
  };

  const originalClose = session.close.bind(session);
  session.close = async () => {
    cancelAllPendingGates("Subagent approval canceled on session close.");
    return originalClose();
  };
}

type DevinClientOptions = ConstructorParameters<typeof GenericACPAgentClient>[0];

// Devin sends the "/" command list in a notification after the session opens: about a second
// later on a quiet machine, later on a busy one (MCP servers starting, several sessions resuming
// at once). Upstream's ACP client answers a request for the list from what it has cached unless
// `waitForInitialCommands` is on, so without it "/" typed in that gap gets an empty list, which
// the app then keeps for a minute. With it the request waits for the list, up to this long (upstream
// waits 1.5 s).
export const DEVIN_COMMANDS_WAIT_MS = 10_000;

export class DevinACPAgentClient extends GenericACPAgentClient {
  private readonly clientLogger: Logger;

  constructor(options: DevinClientOptions) {
    super({
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: DEVIN_COMMANDS_WAIT_MS,
      ...options,
    });
    this.clientLogger = options.logger;
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const session = await super.createSession(config, launchContext, options);
    injectInstructionsIntoFirstPrompt(
      session,
      [
        config.systemPrompt?.trim(),
        // The system prompt set in the app's settings; upstream's ACP client ignores it too.
        config.daemonAppendSystemPrompt?.trim(),
        paseoCommandLineGuide(launchContext?.agentId),
      ]
        .filter(Boolean)
        .join("\n\n"),
      this.clientLogger,
    );
    hideInjectedInstructions(session);
    attachDevinSubagentApprovalGate(session);
    return session;
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    const session = await super.resumeSession(handle, overrides, launchContext, options);
    hideInjectedInstructions(session);
    attachDevinSubagentApprovalGate(session);
    return session;
  }
}

/** The Irix client for a configured ACP provider, or undefined to use upstream's. */
export function createIrixAcpClient(
  providerId: string,
  options: DevinClientOptions,
): GenericACPAgentClient | undefined {
  return isIrixActive() && providerId === DEVIN_PROVIDER_ID
    ? new DevinACPAgentClient(options)
    : undefined;
}
