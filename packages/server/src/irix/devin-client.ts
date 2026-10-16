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

import type { Logger } from "pino";

import type {
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../server/agent/agent-sdk-types.js";
import { GenericACPAgentClient } from "../server/agent/providers/generic-acp-agent.js";
import { isIrixActive } from "./policy.js";
import { isIrixRestricted } from "./restrictions.js";

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
