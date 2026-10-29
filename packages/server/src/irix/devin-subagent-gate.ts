/* oxlint-disable paseo/no-sync-io -- Irix: small config/credential reads outside the request path. */
// Irix edition: blocks Devin's `run_subagent` tool until a human approves it.
//
// Devin auto-approves `run_subagent` in its default permission mode, so it never sends an ACP
// `session/request_permission` for it: the subagent starts at once and the app only hears about it in
// a `session/update` notification, which cannot pause anything. Devin does run `PreToolUse` hooks
// (Claude's hook protocol) before a tool and waits for the hook to exit: exit 0 lets the tool run,
// exit 2 blocks it. So Devin is started with `--config` pointing at a copy of the user's config plus
// a `PreToolUse` hook for `run_subagent`. The hook script asks this loopback server, which asks the
// agent's session (see `attachDevinSubagentApprovalGate`) and answers when the human has decided.
// Anything that goes wrong on the way is a deny.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

export interface SubagentApprovalQuestion {
  toolInput: Record<string, unknown>;
  toolUseId?: string;
}

/** Resolves true when the human allows the subagent. Rejecting or throwing denies it. */
export type SubagentApprover = (question: SubagentApprovalQuestion) => Promise<boolean>;

/** Seconds Devin waits for the hook: the approval wait (10 minutes) and a minute more. */
export const HOOK_TIMEOUT_SECONDS = 11 * 60;

const approvers = new Map<string, SubagentApprover>();
let server: Promise<{ port: number; token: string }> | null = null;

export function registerSubagentApprover(agentId: string, approver: SubagentApprover): () => void {
  approvers.set(agentId, approver);
  return () => {
    if (approvers.get(agentId) === approver) {
      approvers.delete(agentId);
    }
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Hook payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function decide(rawBody: string): Promise<boolean> {
  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  const agentId = typeof payload.agentId === "string" ? payload.agentId : "";
  const approver = approvers.get(agentId);
  if (!approver) {
    return false;
  }
  const toolInput =
    payload.tool_input &&
    typeof payload.tool_input === "object" &&
    !Array.isArray(payload.tool_input)
      ? (payload.tool_input as Record<string, unknown>)
      : {};
  return approver({
    toolInput,
    toolUseId: typeof payload.tool_use_id === "string" ? payload.tool_use_id : undefined,
  });
}

function startServer(): Promise<{ port: number; token: string }> {
  const token = randomBytes(24).toString("hex");
  const httpServer = http.createServer((req, res) => {
    const reply = (allow: boolean) => {
      if (!res.writableEnded) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ decision: allow ? "allow" : "deny" }));
      }
    };
    if (req.method !== "POST" || req.headers["x-irix-gate-token"] !== token) {
      res.writeHead(403).end();
      return;
    }
    readBody(req)
      .then(decide)
      .then(reply, () => reply(false));
  });
  httpServer.unref();
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      resolve({ port: (httpServer.address() as AddressInfo).port, token });
    });
  });
}

/**
 * What the hook runs: read Devin's payload on stdin, ask the daemon (port and token come from
 * `gate.json` next to the script, written when the daemon starts the gate), exit 0 (allow) or 2 (deny).
 */
export function hookScriptSource(): string {
  return `import { readFileSync } from "node:fs";
import http from "node:http";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let payload;
  let gate;
  try {
    payload = JSON.parse(input);
    gate = JSON.parse(readFileSync(new URL("gate.json", import.meta.url), "utf8"));
  } catch {
    process.exit(2);
  }
  payload.agentId = process.env.PASEO_AGENT_ID ?? "";
  const req = http.request(
    { hostname: "127.0.0.1", port: gate.port, path: "/gate", method: "POST",
      headers: { "Content-Type": "application/json", "x-irix-gate-token": gate.token } },
    (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          process.exit(JSON.parse(body).decision === "allow" ? 0 : 2);
        } catch {
          process.exit(2);
        }
      });
    },
  );
  req.on("error", () => process.exit(2));
  req.end(JSON.stringify(payload));
});
`;
}

function readUserConfig(userConfigPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(userConfigPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The user's Devin config with our `PreToolUse` hook for `run_subagent` added; their hooks stay. */
export function buildGatedDevinConfig(
  userConfig: Record<string, unknown>,
  hookCommand: string,
): Record<string, unknown> {
  const userHooks =
    userConfig.hooks && typeof userConfig.hooks === "object" && !Array.isArray(userConfig.hooks)
      ? (userConfig.hooks as Record<string, unknown>)
      : {};
  const existing = Array.isArray(userHooks.PreToolUse) ? userHooks.PreToolUse : [];
  return {
    ...userConfig,
    hooks: {
      ...userHooks,
      PreToolUse: [
        ...existing,
        {
          matcher: "run_subagent",
          // Seen with Devin 3000.11: with no timeout on the hook, the subagent ran while its card was
          // still waiting (nobody had clicked). With this one it stayed held for over three minutes.
          // Longer than the approval wait.
          hooks: [{ type: "command", command: hookCommand, timeout: HOOK_TIMEOUT_SECONDS }],
        },
      ],
    },
  };
}

export interface GatedDevinConfigOptions {
  runtimeDir?: string;
  userConfigPath?: string;
}

function resolveRuntimeDir(options?: GatedDevinConfigOptions): string {
  return (
    options?.runtimeDir ??
    path.join(
      process.env.PASEO_HOME?.trim() || path.join(os.homedir(), ".irix"),
      "runtime",
      "devin",
    )
  );
}

/** Where `devin --config` finds the gated config. The path does not change between launches. */
export function gatedDevinConfigPath(options?: GatedDevinConfigOptions): string {
  return path.join(resolveRuntimeDir(options), "config.json");
}

/**
 * Writes the hook script and the Devin config that calls it (the user's own config plus the hook),
 * and returns the config path for `devin --config`. Synchronous: the path goes into the launch
 * command when the client is built, before any session exists.
 */
export function writeGatedDevinConfig(options?: GatedDevinConfigOptions): string {
  const runtimeDir = resolveRuntimeDir(options);
  mkdirSync(runtimeDir, { recursive: true });
  const scriptPath = path.join(runtimeDir, "subagent-gate-hook.mjs");
  writeFileSync(scriptPath, hookScriptSource(), { encoding: "utf8", mode: 0o600 });
  const userConfigPath =
    options?.userConfigPath ?? path.join(os.homedir(), ".config", "devin", "config.json");
  const config = buildGatedDevinConfig(
    readUserConfig(userConfigPath),
    `"${process.execPath}" "${scriptPath}"`,
  );
  const configPath = gatedDevinConfigPath(options);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return configPath;
}

/**
 * Starts the gate server (once per daemon) and publishes its port and token for the hook. Until
 * this has run, the hook cannot reach the daemon and denies.
 */
export async function ensureSubagentGateRunning(options?: GatedDevinConfigOptions): Promise<void> {
  server ??= startServer();
  const { port, token } = await server;
  const runtimeDir = resolveRuntimeDir(options);
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(path.join(runtimeDir, "gate.json"), JSON.stringify({ port, token }), {
    encoding: "utf8",
    mode: 0o600,
  });
}
