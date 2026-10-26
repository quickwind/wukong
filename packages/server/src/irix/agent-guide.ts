// Irix edition: what an agent is told about working with the other agents in this app, built from
// the host's switches at the moment its session starts. Paseo hands its agent tools over MCP, and on
// company machines both Devin and Claude can be barred from using an MCP server the client passes in,
// so the agent is taught the `irix` command line instead. What it is taught follows the switches in
// restrictions.ts and subagent-approval.ts: a command that the host refuses is not taught, and the
// `irix` command leaves it out of its own help too (cli/src/irix/surface.ts).
//
// Devin gets this in its first prompt (devin-client.ts); Claude gets it in its system prompt
// (claude-agent-guide.ts). Either way it is fixed when the agent is created: a changed switch reaches
// new agents only.

import { isIrixRestricted } from "./restrictions.js";
import { isSubagentApprovalRequired } from "./subagent-approval.js";

export type AgentGuideProvider = "claude" | "devin";

/** How the agent reaches Paseo's agent tools: the `irix` command line, or Paseo's MCP server. */
export type AgentToolsChannel = "cli" | "mcp";

// Starts the command-line section; it is how a stored guide tells which channel its agent was made with.
const COMMAND_LINE_GUIDE_MARKER = "Working with other agents in this app:";

/** The channel an agent was created with, read back from the guide it was given ("mcp" if none). */
export function guideChannelOf(appendedPrompt: string | undefined): AgentToolsChannel {
  return appendedPrompt?.includes(COMMAND_LINE_GUIDE_MARKER) ? "cli" : "mcp";
}

export interface AgentGuideOptions {
  provider: AgentGuideProvider;
  channel: AgentToolsChannel;
  agentId?: string;
}

function commandLineSection(options: AgentGuideOptions): string[] {
  const mayMessage = !isIrixRestricted("agentMessaging");
  const maySchedule = !isIrixRestricted("schedules");
  return [
    options.provider === "devin"
      ? `${COMMAND_LINE_GUIDE_MARKER} you have no MCP tools for it. Use the \`irix\` command in ` +
        "your shell (it talks to the app running on this machine)."
      : `${COMMAND_LINE_GUIDE_MARKER} use the \`irix\` command in your shell (it talks to the app ` +
        "running on this machine). This app's MCP tools are not available to you here.",
    ...(options.agentId
      ? [`Your own agent ID is ${options.agentId} (also in the environment as PASEO_AGENT_ID).`]
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
    mayMessage
      ? "You are not told when an agent you started or messaged finishes. To get its answer, leave out " +
        "--no-wait (the command returns when the agent is done), or for long work ask it in the message " +
        "to report back with `irix send <your ID> ...` when it is finished."
      : "You cannot message other agents. To hand work over, start a new agent with the whole task in its " +
        "first message, then `irix wait <id>` and read its answer with `irix logs <id>`.",
    "A skill or instruction that names Paseo tools (list_agents, create_agent, send_agent_prompt, " +
      "get_agent_activity, wait_for_agent, list_profiles, ...) means these commands: use `irix --help` " +
      "and `irix <command> --help` to find the matching one. Write `irix`, never `paseo`.",
    "Pass the message straight on the command line; do not write it to a file in the project. Keep it on " +
      "one line and avoid double quotes inside it. Only if it truly needs line breaks or quotes, write it " +
      "to a file in the system temp folder (not the project), pass --prompt-file, and delete the file after.",
  ];
}

function subagentApprovalSection(options: AgentGuideOptions): string[] {
  if (!isSubagentApprovalRequired()) {
    return [];
  }
  const workaround = options.channel === "cli" ? "`irix run`" : "the create_agent tool";
  return options.provider === "devin"
    ? [
        "POLICY - MANDATORY SUBAGENT APPROVAL: every `run_subagent` call waits for a human to approve " +
          "it. It may take minutes; wait for it. If it is blocked by a hook, the user denied it: do not " +
          `retry it or work around it (for example with ${workaround}) unless the user asks. Always start ` +
          "subagents in the foreground (`is_background` false): a background subagent cannot ask the user " +
          "to approve its shell commands, so they fail.",
      ]
    : [
        "POLICY - MANDATORY SUBAGENT APPROVAL: every subagent you start (the Task or Agent tool) waits for " +
          "a human to approve it. It may take minutes; wait for it. If the user denies it, do not retry it " +
          `or work around it (for example with ${workaround}) unless the user asks.`,
      ];
}

/** The guide for one agent's session, or "" when there is nothing to tell it. */
export function irixAgentGuide(options: AgentGuideOptions): string {
  return [
    ...(options.channel === "cli" ? commandLineSection(options) : []),
    ...subagentApprovalSection(options),
  ].join("\n");
}

/** The config with the guide for its provider appended after whatever the daemon already appends. */
export function withAgentGuide<T extends { daemonAppendSystemPrompt?: string }>(
  config: T | undefined,
  options: AgentGuideOptions,
): T {
  const base = (config ?? {}) as T;
  const guide = irixAgentGuide(options);
  if (!guide) {
    return base;
  }
  const appended = [base.daemonAppendSystemPrompt?.trim(), guide].filter(Boolean).join("\n\n");
  return { ...base, daemonAppendSystemPrompt: appended };
}
