import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSession } from "../server/agent/agent-sdk-types.js";
import { attachDevinSubagentApprovalGate } from "./devin-client.js";
import {
  buildGatedDevinConfig,
  ensureSubagentGateRunning,
  writeGatedDevinConfig,
} from "./devin-subagent-gate.js";
import { activateIrixPolicy } from "./policy.js";
import { resetSubagentApprovalCacheForTests } from "./subagent-approval.js";

function fakeSession(agentId: string): AgentSession {
  const session = {
    activeForegroundTurnId: "turn-1",
    pushEvent: () => {},
    getPendingPermissions: () => [],
    respondToPermission: async () => {},
    interrupt: async () => {},
    close: async () => {},
  } as unknown as AgentSession;
  attachDevinSubagentApprovalGate(session, agentId);
  return session;
}

// Runs the hook exactly as Devin does: payload on stdin, the decision as the exit code.
function runHook(configPath: string, agentId: string): Promise<number> {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const hook = config.hooks.PreToolUse.find(
    (entry: { matcher?: string }) => entry.matcher === "run_subagent",
  ).hooks[0];
  const child = spawn(hook.command, {
    shell: true,
    env: { ...process.env, PASEO_AGENT_ID: agentId },
  });
  child.stdin.end(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "run_subagent",
      tool_input: { title: "Sleep", task: "sleep 10" },
      tool_use_id: "call_1",
    }),
  );
  return new Promise((resolve) => child.on("close", (code) => resolve(code ?? -1)));
}

describe("Devin subagent approval gate", () => {
  let dir: string;
  let configPath: string;
  let deactivate: () => void;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "irix-gate-"));
    deactivate = activateIrixPolicy();
    resetSubagentApprovalCacheForTests(null);
    const options = { runtimeDir: dir, userConfigPath: path.join(dir, "missing.json") };
    configPath = writeGatedDevinConfig(options);
    await ensureSubagentGateRunning(options);
  });

  afterEach(() => {
    resetSubagentApprovalCacheForTests(null);
    deactivate();
    rmSync(dir, { recursive: true, force: true });
  });

  it("holds the hook until the user approves, then lets it through", async () => {
    const session = fakeSession("agent-allow");
    let exit: number | null = null;
    const hook = runHook(configPath, "agent-allow").then((code) => (exit = code));

    await vi.waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));
    expect(exit).toBeNull();
    const request = session.getPendingPermissions()[0]!;
    expect(request.input).toMatchObject({ task: "sleep 10", toolUseId: "call_1" });

    await session.respondToPermission(request.id, { behavior: "allow" });
    await hook;
    expect(exit).toBe(0);
    expect(session.getPendingPermissions()).toHaveLength(0);
  });

  it("blocks the hook when the user denies", async () => {
    const session = fakeSession("agent-deny");
    const hook = runHook(configPath, "agent-deny");
    await vi.waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));
    await session.respondToPermission(session.getPendingPermissions()[0]!.id, {
      behavior: "deny",
    });
    await expect(hook).resolves.toBe(2);
  });

  it("denies when the session is interrupted, and for an agent nobody registered", async () => {
    const session = fakeSession("agent-interrupt");
    const hook = runHook(configPath, "agent-interrupt");
    await vi.waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));
    await session.interrupt();
    await expect(hook).resolves.toBe(2);
    await expect(runHook(configPath, "unknown-agent")).resolves.toBe(2);
  });

  it("keeps the user's own hooks and adds ours", () => {
    const config = buildGatedDevinConfig(
      { theme_mode: "dark", hooks: { PreToolUse: [{ hooks: [] }], Stop: [] } },
      "run-it",
    ) as { theme_mode: string; hooks: { PreToolUse: unknown[]; Stop: unknown[] } };
    expect(config.theme_mode).toBe("dark");
    expect(config.hooks.Stop).toEqual([]);
    expect(config.hooks.PreToolUse).toHaveLength(2);
  });

  it("gives the hook a timeout longer than the ten-minute approval wait", () => {
    const config = buildGatedDevinConfig({}, "run-it") as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ timeout?: number }> }> };
    };
    const timeout = config.hooks.PreToolUse[0]!.hooks[0]!.timeout;
    expect(timeout).toBeGreaterThan((10 * 60 * 1000) / 1000);
  });
});
