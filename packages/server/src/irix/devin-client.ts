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
import { setTimeout as delay } from "node:timers/promises";
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
  AgentTimelineItem,
  AgentUsage,
} from "../server/agent/agent-sdk-types.js";
import { GenericACPAgentClient } from "../server/agent/providers/generic-acp-agent.js";
import { irixAgentGuide, withAgentGuide } from "./agent-guide.js";
import { withResumedAgentTools } from "./agent-tools-resume.js";
import { getAgentToolsChannel } from "./agent-tools-setting.js";
import { isIrixActive } from "./policy.js";
import { isBypassModeId, isIrixRestricted } from "./restrictions.js";
import { DevinCompaction } from "./devin-compaction.js";
import { formatApprovalForm, previewForApproval } from "./approval-form.js";
import { DevinSubagentCards } from "./devin-subagent-card.js";
import {
  ensureSubagentGateRunning,
  registerSubagentApprover,
  writeGatedDevinConfig,
} from "./devin-subagent-gate.js";
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

/** What Devin is told about Paseo's agent tools: the `irix` command line unless the host says MCP. */
export function paseoCommandLineGuide(agentId?: string): string {
  return irixAgentGuide({ provider: DEVIN_PROVIDER_ID, channel: getAgentToolsChannel(), agentId });
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

interface SubagentGateEntry {
  requestId: string;
  status: "pending" | "settled";
  request: AgentPermissionRequest;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  turnId?: string;
}

interface PermissionOptionLike {
  optionId: string;
}

interface MutableACPSession extends AgentSession {
  activeForegroundTurnId?: string | null;
  pushEvent?: (event: AgentStreamEvent) => void;
  requestPermission?: (params: { options: PermissionOptionLike[] }) => Promise<unknown>;
  replayingHistory?: boolean;
  persistedHistory?: AgentTimelineItem[];
  sessionUpdate?: (params: Record<string, unknown>) => Promise<void>;
  extNotification?: (method: string, params: Record<string, unknown>) => Promise<void>;
  currentTurnUsage?: AgentUsage;
}

/**
 * Turns Devin's own subagents into subagent cards (see devin-subagent-card.ts): after each update
 * is handled as usual, the card it belongs to is sent again with the subagent's task, commands and
 * answer. During the history replay after a resume the session collects the items it will hand out
 * later in `persistedHistory` (a private field of upstream's session), so the card goes there; a
 * later item with the same call id replaces the empty placeholder.
 */
export function attachDevinSubagentCards(sessionInput: AgentSession): void {
  const session = sessionInput as MutableACPSession;
  const original = session.sessionUpdate?.bind(session);
  if (typeof original !== "function") {
    return;
  }
  const cards = new DevinSubagentCards();
  session.sessionUpdate = async (params) => {
    await original(params);
    const event = cards.observe(
      params,
      DEVIN_PROVIDER_ID,
      session.activeForegroundTurnId ?? undefined,
    );
    if (!event) {
      return;
    }
    if (!session.replayingHistory) {
      session.pushEvent?.(event);
    } else if (Array.isArray(session.persistedHistory)) {
      session.persistedHistory.push(event.item);
    }
  };
}

/**
 * Shows Devin's compaction as the compaction marker and clears the context ring when it is done
 * (see devin-compaction.ts). Devin reports it in extension notifications that upstream's session
 * ignores, so this reads them after the session has handled them. Not while a resumed session
 * replays its history: the compaction it shows is long over.
 */
export function attachDevinCompaction(sessionInput: AgentSession): void {
  const session = sessionInput as MutableACPSession;
  const originalUpdate = session.sessionUpdate?.bind(session);
  const originalExt = session.extNotification?.bind(session);
  if (typeof originalUpdate !== "function" || typeof originalExt !== "function") {
    return;
  }
  const compaction = new DevinCompaction();
  session.sessionUpdate = async (params) => {
    compaction.observeUpdate(params);
    if (compaction.isCompactedNotice(params, Boolean(session.activeForegroundTurnId))) {
      return;
    }
    await originalUpdate(params);
  };
  session.extNotification = async (method, params) => {
    await originalExt(method, params);
    if (session.replayingHistory) {
      return;
    }
    const events = compaction.translate({
      method,
      params,
      provider: DEVIN_PROVIDER_ID,
      turnId: session.activeForegroundTurnId ?? undefined,
      turnUsage: session.currentTurnUsage,
    });
    for (const event of events) {
      session.pushEvent?.(event);
    }
  };
}

/**
 * Devin's permission prompts can carry "Yes, switch to bypass mode" (option id `switch_bypass`),
 * which would turn the session into a bypass one behind the back of the mode list we already
 * filter. Drops such options while bypass modes are restricted.
 */
export function attachDevinBypassOptionFilter(sessionInput: AgentSession): void {
  const session = sessionInput as MutableACPSession;
  const original = session.requestPermission?.bind(session);
  if (typeof original !== "function") {
    return;
  }
  session.requestPermission = (params) =>
    original(
      isIrixRestricted("bypassModes")
        ? {
            ...params,
            options: params.options.filter((option) => !isBypassModeId(option.optionId)),
          }
        : params,
    );
}

/**
 * Asks the user before Devin runs `run_subagent`. The question arrives from Devin's `PreToolUse`
 * hook (see devin-subagent-gate.ts), which holds Devin until this resolves; a 10-minute timeout,
 * an interrupt or closing the session denies it. The request shows as a normal permission card.
 */
export function attachDevinSubagentApprovalGate(
  sessionInput: AgentSession,
  agentId: string | undefined,
): void {
  const session = sessionInput as MutableACPSession;
  const gates = new Map<string, SubagentGateEntry>();

  const settleGate = (entry: SubagentGateEntry, response: AgentPermissionResponse) => {
    if (entry.status !== "pending") {
      return;
    }
    clearTimeout(entry.timer);
    entry.status = "settled";
    gates.delete(entry.requestId);
    session.pushEvent?.({
      type: "permission_resolved",
      provider: DEVIN_PROVIDER_ID,
      requestId: entry.requestId,
      resolution: response,
      turnId: entry.turnId,
    });
    entry.resolve(response.behavior === "allow");
  };

  const cancelAllPendingGates = (reason: string) => {
    for (const entry of gates.values()) {
      settleGate(entry, { behavior: "deny", message: reason });
    }
  };

  const unregister = agentId
    ? registerSubagentApprover(agentId, ({ toolInput, toolUseId }) => {
        if (!isSubagentApprovalRequired()) {
          return Promise.resolve(true);
        }
        const requestId = `devin-subagent-${randomUUID()}`;
        const turnId = session.activeForegroundTurnId ?? undefined;
        const request: AgentPermissionRequest = {
          id: requestId,
          provider: DEVIN_PROVIDER_ID,
          name: "SpawnSubagent",
          kind: "other",
          title: "Require Subagent Approval (Devin subagent)",
          description:
            "Devin is requesting to spawn an internal subagent. Human approval is required.",
          input: { ...(toolUseId ? { toolUseId } : {}), ...toolInput },
          detail: {
            type: "plain_text",
            text: formatApprovalForm([
              ["Title", toolInput.title],
              ["Profile", toolInput.profile],
              ["Background", toolInput.is_background],
              ["Task", previewForApproval(toolInput.task)],
            ]),
          },
        };
        return new Promise<boolean>((resolve) => {
          const entry: SubagentGateEntry = {
            requestId,
            status: "pending",
            request,
            resolve,
            turnId,
            timer: setTimeout(() => {
              settleGate(entry, {
                behavior: "deny",
                message: "Subagent approval timed out after 10 minutes.",
              });
            }, SUBAGENT_APPROVAL_TIMEOUT_MS),
          };
          entry.timer.unref?.();
          gates.set(requestId, entry);
          session.pushEvent?.({
            type: "permission_requested",
            provider: DEVIN_PROVIDER_ID,
            request,
            turnId,
          });
        });
      })
    : () => {};

  const originalGetPending = session.getPendingPermissions.bind(session);
  session.getPendingPermissions = () => [
    ...originalGetPending(),
    ...Array.from(gates.values(), (entry) => entry.request),
  ];

  const originalRespond = session.respondToPermission.bind(session);
  session.respondToPermission = async (requestId: string, response: AgentPermissionResponse) => {
    const entry = gates.get(requestId);
    if (entry) {
      settleGate(entry, response);
      return;
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
    unregister();
    cancelAllPendingGates("Subagent approval canceled on session close.");
    return originalClose();
  };
}

// How long a new message waits for Devin to end a turn that was already canceled. Devin ends the
// turn with its answer to the original `session/prompt`, which can come after the daemon's own
// short wait for a canceled turn (2 s) has run out.
export const DEVIN_TURN_END_WAIT_MS = 30_000;
const TURN_END_POLL_MS = 25;

// Shown in the chat when Devin has not ended a canceled turn within the wait, so the message was not
// sent. The menu item is "Reload agent" in the tab menu.
export const DEVIN_TURN_STILL_ENDING_MESSAGE =
  "Devin has not finished the previous task yet, so this message was not sent. " +
  "Wait a few seconds and send it again. If this keeps happening, use Reload agent from the tab menu.";

/**
 * Makes a message sent right after an interrupt wait for Devin to end the canceled turn. The daemon
 * waits only a moment for a canceled turn to end, then treats it as over and starts the next one;
 * upstream's ACP session still holds the turn until Devin answers its `session/prompt`, so the new
 * turn failed with "A foreground turn is already active". Only a turn this session was asked to
 * cancel is waited for; any other overlap still fails at once. If Devin does not end the turn
 * within the wait, the message fails with a message that says what to do next.
 */
export function attachDevinTurnEndWait(
  sessionInput: AgentSession,
  logger?: Logger,
  waitMs = DEVIN_TURN_END_WAIT_MS,
): void {
  const session = sessionInput as MutableACPSession;
  const originalStartTurn = session.startTurn?.bind(session);
  if (typeof originalStartTurn !== "function") {
    return;
  }
  let canceledTurnId: string | null = null;
  const lifecycle = { closed: false };

  const originalInterrupt = session.interrupt.bind(session);
  session.interrupt = async () => {
    canceledTurnId = session.activeForegroundTurnId ?? canceledTurnId;
    return originalInterrupt();
  };

  const originalClose = session.close.bind(session);
  session.close = async () => {
    lifecycle.closed = true;
    return originalClose();
  };

  const waitForTurnEnd = async (turnId: string) => {
    const deadline = Date.now() + waitMs;
    while (
      session.activeForegroundTurnId === turnId &&
      !lifecycle.closed &&
      Date.now() < deadline
    ) {
      await delay(TURN_END_POLL_MS);
    }
  };

  session.startTurn = async (prompt, options) => {
    const turnId = session.activeForegroundTurnId;
    if (turnId && turnId === canceledTurnId) {
      logger?.info({ turnId }, "Waiting for Devin to end the canceled turn before the next one");
      await waitForTurnEnd(turnId);
      if (session.activeForegroundTurnId === turnId && !lifecycle.closed) {
        logger?.warn({ turnId, waitMs }, "Devin did not end the canceled turn in time");
        throw new Error(DEVIN_TURN_STILL_ENDING_MESSAGE);
      }
    }
    return originalStartTurn(prompt, options);
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

/**
 * Adds `--config <gated config>` in front of `acp`, so Devin runs the `PreToolUse` hook for
 * `run_subagent` (see devin-subagent-gate.ts). A session starts Devin from this command, so the
 * flag has to be in it. The hook allows at once while approval is switched off.
 */
export function withSubagentGate(
  command: DevinClientOptions["command"],
): DevinClientOptions["command"] {
  const acpAt = command.indexOf("acp");
  if (acpAt < 0) {
    throw new Error("Cannot gate Devin subagents: the launch command has no `acp` argument.");
  }
  const gated = [...command];
  gated.splice(acpAt, 0, "--config", writeGatedDevinConfig());
  return gated as DevinClientOptions["command"];
}

export class DevinACPAgentClient extends GenericACPAgentClient {
  private readonly clientLogger: Logger;

  constructor(options: DevinClientOptions) {
    super({
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: DEVIN_COMMANDS_WAIT_MS,
      // Lets usage sources match a Devin session, so its context window card shows the plan usage.
      usageProvider: DEVIN_PROVIDER_ID,
      ...options,
      command: withSubagentGate(options.command),
    });
    this.clientLogger = options.logger;
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    await ensureSubagentGateRunning();
    // The guide goes into the stored config as well as the first prompt: both providers persist
    // `daemonAppendSystemPrompt`, which is how a resume finds out which mode this agent was made in.
    const guided = withAgentGuide(config, {
      provider: DEVIN_PROVIDER_ID,
      channel: getAgentToolsChannel(),
      agentId: launchContext?.agentId,
    });
    const session = await super.createSession(guided, launchContext, options);
    injectInstructionsIntoFirstPrompt(
      session,
      [
        config.systemPrompt?.trim(),
        // The system prompt set in the app's settings, then the guide; upstream's ACP client ignores both.
        guided.daemonAppendSystemPrompt?.trim(),
      ]
        .filter(Boolean)
        .join("\n\n"),
      this.clientLogger,
    );
    hideInjectedInstructions(session);
    attachDevinSubagentApprovalGate(session, launchContext?.agentId);
    attachDevinBypassOptionFilter(session);
    attachDevinSubagentCards(session);
    attachDevinCompaction(session);
    attachDevinTurnEndWait(session, this.clientLogger);
    return session;
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    await ensureSubagentGateRunning();
    // Keeps the guide and the MCP server this agent was created with, not the current setting's.
    const session = await super.resumeSession(
      handle,
      withResumedAgentTools(
        handle,
        overrides,
        launchContext?.agentId,
      ) as Partial<AgentSessionConfig>,
      launchContext,
      options,
    );
    hideInjectedInstructions(session);
    attachDevinSubagentApprovalGate(session, launchContext?.agentId);
    attachDevinBypassOptionFilter(session);
    attachDevinSubagentCards(session);
    attachDevinCompaction(session);
    attachDevinTurnEndWait(session, this.clientLogger);
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
