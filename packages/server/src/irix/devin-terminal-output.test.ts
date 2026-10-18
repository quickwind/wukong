// Devin never names the terminal in a tool call (no `terminal` content) and releases it before
// the call completes, so the chat shows its shell output only if the session matches the
// released terminal to the call by command. See IRIX.md, "Devin's shell output in the chat".
import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

import { ACPAgentSession } from "../server/agent/providers/acp-agent.js";
import { asInternals } from "../server/test-utils/class-mocks.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import * as spawnUtils from "../utils/spawn.js";

interface ShellTimelineItem {
  type: string;
  callId?: string;
  status?: string;
  detail?: { type: string; command?: string; output?: string; exitCode?: number | null };
}

function createSession(): ACPAgentSession {
  const session = new ACPAgentSession(
    { provider: "devin", cwd: "/tmp/paseo-acp-test" },
    {
      provider: "devin",
      logger: createTestLogger(),
      defaultCommand: ["devin", "acp"],
      defaultModes: [],
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
    },
  );
  asInternals<{ sessionId: string | null }>(session).sessionId = "session-1";
  return session;
}

function createTerminalChildStub(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.kill = vi.fn(() => true) as ChildProcess["kill"];
  return child;
}

function collectToolCalls(session: ACPAgentSession): ShellTimelineItem[] {
  const items: ShellTimelineItem[] = [];
  session.subscribe((event) => {
    if (event.type === "timeline" && event.item.type === "tool_call") {
      items.push(event.item as ShellTimelineItem);
    }
  });
  return items;
}

function isCompleted(item: ShellTimelineItem): boolean {
  return item.status === "completed";
}

function callAndOutput(item: ShellTimelineItem): Array<string | undefined> {
  return [item.callId, item.detail?.output];
}

// The order Devin uses: terminal/create, the tool call, terminal/output, terminal/release,
// then the call completes with only the text "Exited with code 0".
async function runDevinShellCall(input: {
  session: ACPAgentSession;
  toolCallId: string;
  command: string;
  output: string;
}): Promise<void> {
  const { session, toolCallId, command, output } = input;
  const child = createTerminalChildStub();
  vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child as ChildProcessWithoutNullStreams);
  const { terminalId } = await session.createTerminal({ sessionId: "session-1", command });
  vi.restoreAllMocks();
  await session.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Ran git",
      kind: "execute",
      rawInput: { command },
    } as SessionUpdate,
  });
  child.stdout!.emit("data", Buffer.from(output));
  child.emit("exit", 0, null);
  await session.waitForTerminalExit({ sessionId: "session-1", terminalId });
  await session.releaseTerminal({ sessionId: "session-1", terminalId });
  await session.sessionUpdate({
    sessionId: "session-1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Exited with code 0" } }],
    } as SessionUpdate,
  });
}

describe("Devin shell tool calls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("show the output of the released terminal that ran the same command", async () => {
    const session = createSession();
    const items = collectToolCalls(session);

    await runDevinShellCall({
      session,
      toolCallId: "call-1",
      command: "git log -3 --oneline",
      output: "abc123 first\ndef456 second\n",
    });

    expect(items.findLast(isCompleted)?.detail).toMatchObject({
      type: "shell",
      command: "git log -3 --oneline",
      output: "abc123 first\ndef456 second\n",
      exitCode: 0,
    });
  });

  test("give two runs of the same command their own output", async () => {
    const session = createSession();
    const items = collectToolCalls(session);

    for (const [toolCallId, output] of [
      ["call-1", "first run\n"],
      ["call-2", "second run\n"],
    ] as const) {
      await runDevinShellCall({ session, toolCallId, command: "git status", output });
    }

    expect(items.filter(isCompleted).map(callAndOutput)).toEqual([
      ["call-1", "first run\n"],
      ["call-2", "second run\n"],
    ]);
  });
});
