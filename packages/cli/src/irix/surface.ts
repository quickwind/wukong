// The Irix command tree: the upstream one without the commands Irix does not use. Applied at the
// end of createCli so upstream's registration code stays as it is.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import { resolveClientPaseoHome } from "../utils/client.js";
import { installCallerRouting } from "./caller-routing.js";
import { selectDaemonTarget } from "../utils/daemon-target.js";

const UNUSED_COMMANDS = ["clone", "onboard", "pair", "hub", "speech"];
const CLI_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

function isEnvOn(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function isCliSubagentApprovalRequired(
  daemonHome: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const unlocked =
    isEnvOn(env.IRIX_UNRESTRICTED) || isEnvOn(env.IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL);
  if (!unlocked) {
    return true;
  }
  const configPath = path.join(daemonHome, "daemon.json");
  if (!existsSync(configPath)) {
    return true;
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (typeof raw.requireSubagentApproval === "boolean") {
      return raw.requireSubagentApproval;
    }
    const daemon = raw.daemon as Record<string, unknown> | undefined;
    if (daemon && typeof daemon.requireSubagentApproval === "boolean") {
      return daemon.requireSubagentApproval;
    }
  } catch {
    return true;
  }
  return true;
}

export type CliApprovalPromptFn = (summary: {
  provider: string;
  cwd: string;
  prompt: string;
  timeoutMs: number;
}) => Promise<boolean>;

let customPromptFn: CliApprovalPromptFn | null = null;

export function setCliApprovalPromptForTests(fn: CliApprovalPromptFn | null): void {
  customPromptFn = fn;
}

export async function promptCliSubagentApproval(
  summary: {
    provider: string;
    cwd: string;
    prompt: string;
    timeoutMs?: number;
  },
  io: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  } = {},
): Promise<boolean> {
  const timeoutMs = summary.timeoutMs ?? CLI_APPROVAL_TIMEOUT_MS;
  if (customPromptFn) {
    return customPromptFn({ ...summary, timeoutMs });
  }

  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stderr;
  const preview =
    summary.prompt.length > 160 ? `${summary.prompt.slice(0, 160)}...` : summary.prompt;

  output.write(
    [
      "\n[Require Subagent Approval] Agent task launch requested:",
      `  Provider : ${summary.provider}`,
      `  Directory: ${summary.cwd}`,
      `  Prompt   : ${preview}`,
      "Approve task launch? (yes/no): ",
    ].join("\n"),
  );

  let resolveDecision!: (approved: boolean) => void;
  const decisionPromise = new Promise<boolean>((resolve) => {
    resolveDecision = resolve;
  });

  let settled = false;
  const rl = createInterface({
    input,
    terminal: false,
  });

  const finish = (approved: boolean) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    rl.close();
    resolveDecision(approved);
  };

  const timer = setTimeout(() => {
    output.write("\nApproval timed out after 10 minutes. Automatically rejected.\n");
    finish(false);
  }, timeoutMs);
  timer.unref?.();

  rl.on("line", (line) => {
    const normalized = line.trim().toLowerCase();
    if (normalized === "yes" || normalized === "y") {
      finish(true);
      return;
    }
    if (normalized === "no" || normalized === "n") {
      finish(false);
      return;
    }
    output.write("Please enter yes or no: ");
  });

  rl.on("close", () => {
    finish(false);
  });

  return decisionPromise;
}

export interface CliApprovalContext {
  /** The agent this shell belongs to (PASEO_AGENT_ID), checked with the daemon when the run sends. */
  callerAgentId: string | undefined;
  interactive: boolean;
  summary: { provider: string; cwd: string; prompt: string };
}

/**
 * Who asks for approval before a run starts. An agent's own shell never answers: the daemon raises
 * the approval card in that agent's chat when it gets the request with the caller named (see
 * `server/irix/create-approval.ts`), so nothing here reads stdin. Only a person at a terminal, with
 * no calling agent, is prompted; with no terminal the run is refused without reading stdin. The
 * environment and the terminal only route the request, the daemon decides for any agent caller.
 */
export async function resolveCliApproval(context: CliApprovalContext): Promise<void> {
  if (context.callerAgentId) {
    return;
  }
  if (!context.interactive) {
    throw {
      code: "SUBAGENT_APPROVAL_REQUIRED",
      message:
        "Subagent approval is required, and no calling agent or interactive terminal is available to approve this run.",
    };
  }
  const approved = await promptCliSubagentApproval(context.summary);
  if (!approved) {
    throw {
      code: "SUBAGENT_APPROVAL_REJECTED",
      message: "Agent task launch rejected (denied by user or approval timed out).",
    };
  }
}

function attachRunApprovalHook(runCommand: Command | undefined): void {
  if (!runCommand) {
    return;
  }
  runCommand.hook("preAction", async (_thisCommand, actionCommand) => {
    const prompt = String(actionCommand.args[0] ?? "").trim();
    if (!prompt) {
      return;
    }
    const opts = actionCommand.optsWithGlobals() as {
      provider?: string;
      cwd?: string;
      home?: string;
      host?: string;
    };
    const target = selectDaemonTarget(opts, process.env, false);
    const home = resolveClientPaseoHome(target, process.env);
    if (!isCliSubagentApprovalRequired(home, process.env)) {
      return;
    }

    // Inside an agent's shell the daemon asks that agent; `installCallerRouting` refuses a creation
    // that names no caller the daemon knows, on the run's own connection.
    const callerAgentId = process.env.PASEO_AGENT_ID?.trim() || undefined;
    await resolveCliApproval({
      callerAgentId,
      interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
      summary: { provider: opts.provider ?? "default", cwd: opts.cwd ?? process.cwd(), prompt },
    });
  });
}

function removeCommand(parent: Command, name: string): void {
  const commands = parent.commands as Command[];
  const index = commands.findIndex((command) => command.name() === name);
  if (index >= 0) {
    commands.splice(index, 1);
  }
}

/**
 * Leaves out what the daemon would refuse, read from the same environment variables the daemon
 * reads (an agent's shell inherits them). The daemon enforces its own switches whatever this does:
 * schedules are refused for everyone, a message between agents when an agent sends it. Schedules
 * and heartbeats go for everyone, `send` only inside an agent (PASEO_AGENT_ID is set in an agent's
 * shell), so a person at a terminal keeps it.
 */
function removeSwitchedOffCommands(program: Command, env: NodeJS.ProcessEnv = process.env): void {
  const unrestricted = isEnvOn(env.IRIX_UNRESTRICTED);
  if (!unrestricted && !isEnvOn(env.IRIX_ALLOW_SCHEDULES)) {
    removeCommand(program, "schedule");
    removeCommand(program, "heartbeat");
  }
  if (!unrestricted && !isEnvOn(env.IRIX_ALLOW_AGENT_MESSAGING) && env.PASEO_AGENT_ID) {
    removeCommand(program, "send");
    const agent = program.commands.find((command) => command.name() === "agent");
    if (agent) {
      removeCommand(agent, "send");
    }
  }
}

export function applyIrixSurface(program: Command): Command {
  program
    .name("irix")
    .description("Irix CLI - control your AI coding agents from the command line");
  for (const name of UNUSED_COMMANDS) {
    removeCommand(program, name);
  }
  if (!isEnvOn(process.env.IRIX_ENABLE_CONNECTED_HOSTS)) {
    removeCommand(program, "host");
  }
  removeSwitchedOffCommands(program);
  installCallerRouting();
  const daemon = program.commands.find((command) => command.name() === "daemon");
  if (daemon) {
    removeCommand(daemon, "pair");
  }
  attachRunApprovalHook(program.commands.find((command) => command.name() === "run"));
  const agent = program.commands.find((command) => command.name() === "agent");
  attachRunApprovalHook(agent?.commands.find((command) => command.name() === "run"));
  return program;
}
