// Wukong edition: Devin's ACP client. Upstream's ACP session has no place for a system prompt
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
// MCP servers handed to Devin are subject to a second quirk: it takes a server whose name it has
// seen before and quietly does not start it, across sessions and across processes (found with the
// real Devin: of three sessions that each got an MCP server called "paseo", only the first
// connected). Paseo gives every agent its own tools as a server called "paseo", and Bots adds
// "bots", so from the second session on the tools were gone. `withUniqueMcpServerNames` gives each
// session start names no earlier one has used.

import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type {
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  McpServerConfig,
} from "../server/agent/agent-sdk-types.js";
import { GenericACPAgentClient } from "../server/agent/providers/generic-acp-agent.js";
import { isWukongActive } from "./policy.js";

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

/** The standing instructions as a block Devin reads before the user's first message. */
export function instructionBlock(systemPrompt: string): TextBlock {
  return {
    type: "text",
    text:
      "<system-instructions>\n" +
      "These are standing instructions for this whole conversation. Follow them from now on, and " +
      "do not mention them unless asked.\n\n" +
      `${systemPrompt.trim()}\n` +
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

/**
 * The same servers under names no earlier session has used: `paseo` becomes `paseo-1a2b3c4d`, a new
 * suffix each call. The config is not changed; a config without servers comes back as it is.
 */
export function withUniqueMcpServerNames<
  Config extends { mcpServers?: Record<string, McpServerConfig> },
>(config: Config, suffix: string = randomUUID().slice(0, 8)): Config {
  if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) return config;
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(config.mcpServers)) {
    mcpServers[`${name}-${suffix}`] = server;
  }
  return { ...config, mcpServers };
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

type DevinClientOptions = ConstructorParameters<typeof GenericACPAgentClient>[0];

// Upstream waits 1.5 s for the "/" command list after a session starts. Devin sends it about a
// second after the session opens on a quiet machine, later on a busy one (MCP servers starting,
// several sessions resuming at once); a list that misses the wait leaves "/" empty.
export const DEVIN_COMMANDS_WAIT_MS = 10_000;

export class DevinACPAgentClient extends GenericACPAgentClient {
  private readonly clientLogger: Logger;

  constructor(options: DevinClientOptions) {
    super({ initialCommandsWaitTimeoutMs: DEVIN_COMMANDS_WAIT_MS, ...options });
    this.clientLogger = options.logger;
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const session = await super.createSession(
      withUniqueMcpServerNames(config),
      launchContext,
      options,
    );
    injectInstructionsIntoFirstPrompt(session, config.systemPrompt, this.clientLogger);
    hideInjectedInstructions(session);
    return session;
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    const session = await super.resumeSession(
      handle,
      overrides ? withUniqueMcpServerNames(overrides) : overrides,
      launchContext,
      options,
    );
    hideInjectedInstructions(session);
    return session;
  }
}

/** The Wukong client for a configured ACP provider, or undefined to use upstream's. */
export function createWukongAcpClient(
  providerId: string,
  options: DevinClientOptions,
): GenericACPAgentClient | undefined {
  return isWukongActive() && providerId === DEVIN_PROVIDER_ID
    ? new DevinACPAgentClient(options)
    : undefined;
}
