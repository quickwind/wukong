// A provider can say that one of the commands it advertises is a skill, and the app then offers it
// in the middle of a message too. See IRIX.md, "Devin's slash commands".
import { describe, expect, test } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

import { ACPAgentSession } from "../server/agent/providers/acp-agent.js";
import { asInternals } from "../server/test-utils/class-mocks.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { irixCommandKind } from "./command-kind.js";

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

// The shape Devin sends: every command carries the category it belongs to.
function devinCommand(name: string, category: string) {
  return {
    name,
    description: `The ${name} command`,
    _meta: { "cognition.ai/icon": "zap", "cognition.ai/category": category },
  };
}

describe("the commands a provider advertises", () => {
  test("the skills are the ones Devin files under the Skills category", () => {
    expect(irixCommandKind(devinCommand("find-skills", "Skills"))).toBe("skill");
    expect(irixCommandKind(devinCommand("context", "Session"))).toBe("command");
  });

  test("a command without a category is a plain command", () => {
    expect(irixCommandKind({ name: "context", description: "Show usage" })).toBe("command");
  });

  test("another provider's command stays a plain command", () => {
    expect(
      irixCommandKind({
        name: "research_codebase",
        description: "Search the workspace",
        _meta: { "some.other.vendor/category": "Skills" },
      }),
    ).toBe("command");
  });

  test("the session reports the skills as skills, so the app can offer them mid-prompt", async () => {
    const session = createSession();

    await session.sessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          devinCommand("context", "Session"),
          devinCommand("find-skills", "Skills"),
        ],
      } as SessionUpdate,
    });

    expect(await session.listCommands()).toEqual([
      {
        name: "context",
        description: "The context command",
        argumentHint: "",
        kind: "command",
      },
      {
        name: "find-skills",
        description: "The find-skills command",
        argumentHint: "",
        kind: "skill",
      },
    ]);
  });
});
