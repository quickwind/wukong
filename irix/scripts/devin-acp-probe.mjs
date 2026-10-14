// Probe: what does `devin acp` send back? Used to find out why something Paseo shows from an ACP
// agent (the context-window ring, the "/" command list, usage) is missing for Devin.
//
//   node devin-acp-probe.mjs [--prompt /context] [--prompt "Reply with the word OK"] [--reload]
//        [--out probe.txt] [--cmd devin] [--cwd .] [--raw]
//
// Starts `devin acp`, opens a session, sends each --prompt in turn (default: /usage) and prints a
// short report: which kinds of update arrived and WHEN, any usage_update in full, the reply text,
// and every field whose name mentions usage, token, context, cost, acu or credit.
//
// --reload then stops that `devin acp`, starts a new one and resumes the SAME session with
// session/load, the way Paseo resumes a chat after the daemon restarts, and reports whether the
// "/" command list arrives again and how long it takes. Paseo shows an empty "/" list in a resumed
// chat when it does not.
//
// --raw prints every message. --out writes the report as UTF-8 (PowerShell's `>` writes UTF-16).
// A plain prompt makes Devin answer, which uses a little of your ACU; slash commands such as
// /context should not.
//
// No login token is read or sent by this script; the devin process uses its own stored login.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const values = (name) =>
  argv.flatMap((item, index) => (item === `--${name}` && argv[index + 1] ? [argv[index + 1]] : []));
const first = (name, fallback) => values(name)[0] ?? fallback;

const command = first("cmd", "devin");
const prompts = values("prompt").length > 0 ? values("prompt") : ["/usage"];
const cwd = first("cwd", process.cwd());
const outFile = first("out");
const raw = flag("raw");
const reload = flag("reload");
const PROMPT_TIMEOUT_MS = 180_000;
const SETTLE_MS = 2_500;
const RELOAD_WATCH_MS = 12_000;
const INTERESTING = /usage|token|context|cost|acu|credit|window|quota/iu;
const NOISY_METHODS = new Set(["_cognition.ai/output", "_cognition.ai/mcp/serversChanged"]);

if (outFile) writeFileSync(outFile, "");
const say = (line) => {
  console.log(line);
  if (outFile) appendFileSync(outFile, `${line}\n`);
};
const clip = (value, max = 600) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}... (${text.length} chars)` : text;
};

// Field paths whose name looks like usage/context information, with a short value.
function interestingFields(value, prefix = "", found = []) {
  if (value === null || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (INTERESTING.test(key)) found.push(`${at} = ${clip(child, 160)}`);
    interestingFields(child, at, found);
  }
  return found;
}

const counts = new Map();
const count = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
let usageUpdates = 0;

/** One `devin acp` process, and what has been heard from it since the last `mark()`. */
class Agent {
  constructor(label) {
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.markedAt = Date.now();
    this.commandUpdates = [];
    this.child = spawn(command, ["acp"], {
      stdio: ["pipe", "pipe", "inherit"],
      shell: process.platform === "win32",
    });
    this.child.on("error", (error) => {
      console.error(`could not start '${command} acp': ${error.message}`);
      process.exit(1);
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
  }

  mark() {
    this.markedAt = Date.now();
    this.commandUpdates = [];
  }

  since() {
    return `+${Date.now() - this.markedAt}ms`;
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  send(method, params, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer in ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      if (raw) say(`>> ${JSON.stringify({ id, method, params })}`);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let newline;
    while ((newline = this.buffer.indexOf("\n")) > -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
    }
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      say(`?? ${clip(line, 200)}`);
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (raw) say(`<< ${JSON.stringify(message)}`);
      if (!waiter) return;
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      // The agent is asking us something (permission, file access). Decline so it carries on.
      const decline =
        message.method === "session/request_permission"
          ? { result: { outcome: { outcome: "cancelled" } } }
          : { error: { code: -32601, message: "not supported by probe" } };
      this.write({ jsonrpc: "2.0", id: message.id, ...decline });
      count(`request-declined:${message.method}`);
      return;
    }
    this.report(message);
  }

  report(message) {
    if (raw) {
      say(`<< ${JSON.stringify(message)}`);
      return;
    }
    if (message.method === "session/update") {
      const update = message.params?.update ?? {};
      const kind = update.sessionUpdate ?? "(unknown)";
      count(`update:${kind}`);
      if (kind === "usage_update") {
        usageUpdates += 1;
        say(`<< usage_update ${clip(update, 400)}`);
      } else if (kind === "agent_message_chunk") {
        say(`<< agent says: ${clip(update.content?.text ?? update.content, 400)}`);
      } else if (kind === "available_commands_update") {
        const names = (update.availableCommands ?? []).map((c) => c.name);
        this.commandUpdates.push({ at: this.since(), count: names.length });
        const wanted = names.filter(
          (n) => INTERESTING.test(n) || /^(status|session-stats)$/u.test(n),
        );
        say(
          `<< [${this.label} ${this.since()}] ${names.length} commands; related: ${wanted.join(", ") || "(none)"}`,
        );
      } else {
        const fields = interestingFields(update);
        if (fields.length > 0) say(`<< ${kind}: ${fields.join("; ")}`);
      }
      return;
    }
    if (message.method) {
      count(`notification:${message.method}`);
      if (NOISY_METHODS.has(message.method)) return;
      say(`<< ${message.method} ${clip(message.params, 500)}`);
    }
  }

  stop() {
    this.child.kill();
  }
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function commandSummary(agent, what) {
  const [firstUpdate] = agent.commandUpdates;
  if (!firstUpdate) {
    say(`   ${what}: NO command list arrived`);
  } else {
    say(
      `   ${what}: the command list first arrived ${firstUpdate.at} later ` +
        `(${agent.commandUpdates.length} update(s); the last has ${agent.commandUpdates.at(-1).count} commands)`,
    );
  }
}

let sessionId;
const agent = new Agent("session");
try {
  const init = await agent.send("initialize", { protocolVersion: 1, clientCapabilities: {} });
  say(`initialize: agent ${clip(init.agentInfo, 200)}`);
  const initFields = interestingFields(init);
  if (initFields.length > 0) say(`  related fields: ${initFields.join("; ")}`);
  agent.mark();
  const session = await agent.send("session/new", { cwd, mcpServers: [] });
  sessionId = session.sessionId;
  say(
    `session/new: ${sessionId}; answered ${agent.since()} after the request; ` +
      `related fields: ${interestingFields(session).join("; ") || "(none)"}`,
  );
  await settle(SETTLE_MS);
  commandSummary(agent, "new session");
  for (const text of prompts) {
    say(`\n-- prompt: ${text}`);
    try {
      const result = await agent.send(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text }] },
        PROMPT_TIMEOUT_MS,
      );
      say(`-- prompt result: ${clip(result, 1200)}`);
    } catch (error) {
      say(`-- prompt failed: ${error.message}`);
    }
    await settle(SETTLE_MS);
  }
} catch (error) {
  say(`-- failed: ${error.message}`);
}
agent.stop();

if (reload && sessionId) {
  say("\n== reload: a new `devin acp` resumes the same session with session/load");
  await settle(1_500);
  const resumed = new Agent("resumed");
  try {
    await resumed.send("initialize", { protocolVersion: 1, clientCapabilities: {} });
    resumed.mark();
    const loaded = await resumed.send("session/load", { sessionId, cwd, mcpServers: [] });
    say(
      `session/load: answered ${resumed.since()} after the request; ` +
        `related fields: ${interestingFields(loaded).join("; ") || "(none)"}`,
    );
    await settle(RELOAD_WATCH_MS);
    commandSummary(resumed, "resumed session");
    say(
      resumed.commandUpdates.length === 0
        ? `   => after session/load Devin sent no command list within ${RELOAD_WATCH_MS / 1000}s: ` +
            'Paseo would show an empty "/" list in a resumed chat'
        : '   => Devin re-sends the command list after session/load: a resumed chat can show "/"',
    );
  } catch (error) {
    say(`-- reload failed: ${error.message}`);
  }
  resumed.stop();
}

say("\n== summary");
for (const [name, n] of [...counts].sort()) say(`  ${String(n).padStart(3)}  ${name}`);
say(
  `usage_update messages seen: ${usageUpdates}${usageUpdates === 0 ? "  (Paseo's context ring has nothing to show)" : ""}`,
);
process.exit(0);
