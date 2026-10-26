import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACPAgentClient } from "../server/agent/providers/acp-agent.js";
import { resetAgentToolsForTests, setAgentToolsChannel } from "./agent-tools-setting.js";
import { rememberAgentManagerForGuide, resetAgentManagerForTests } from "./agent-tools-resume.js";
import { DevinACPAgentClient, instructionBlock } from "./devin-client.js";
import { activateIrixPolicy } from "./policy.js";

vi.mock("./devin-subagent-gate.js", () => ({
  ensureSubagentGateRunning: async () => {},
  registerSubagentApprover: () => {},
  writeGatedDevinConfig: () => {},
}));

type Proto = Record<"createSession" | "resumeSession", (...args: unknown[]) => Promise<unknown>>;
const proto = ACPAgentClient.prototype as unknown as Proto;
const real = { create: proto.createSession, resume: proto.resumeSession };

/** A session that accepts whatever the attach functions bind or wrap, and answers with nothing. */
function fakeSession(base: Record<string, unknown>) {
  return new Proxy(base, {
    get: (target, property) =>
      property in target || property === "then" ? target[property as string] : () => [],
  });
}

const ENDPOINT = { mcpBaseUrl: "http://127.0.0.1:6931/mcp/agents", mcpAuthToken: "fresh-token" };

describe("Devin follows the agent tools setting like Claude", () => {
  let deactivate: () => void;
  let calls: unknown[][];
  let prompts: Array<{ prompt: Array<{ text: string }> }>;
  const saved = process.env.IRIX_UNRESTRICTED;
  const savedHome = process.env.PASEO_HOME;

  function client() {
    return new DevinACPAgentClient({
      logger: pino({ level: "silent" }),
      command: ["devin", "acp"],
      providerId: "devin",
    } as never);
  }

  beforeEach(() => {
    delete process.env.IRIX_UNRESTRICTED;
    delete process.env.PASEO_HOME;
    calls = [];
    prompts = [];
    proto.createSession = async (...args: unknown[]) => {
      calls.push(args);
      return fakeSession({
        connection: {
          prompt: async (params: { prompt: Array<{ text: string }> }) => prompts.push(params),
        },
        streamHistory: async function* () {},
      });
    };
    proto.resumeSession = async (...args: unknown[]) => {
      calls.push(args);
      return fakeSession({ streamHistory: async function* () {} });
    };
    resetAgentToolsForTests();
    resetAgentManagerForTests();
    deactivate = activateIrixPolicy();
  });

  afterEach(() => {
    deactivate();
    proto.createSession = real.create;
    proto.resumeSession = real.resume;
    resetAgentToolsForTests();
    resetAgentManagerForTests();
    if (saved === undefined) delete process.env.IRIX_UNRESTRICTED;
    else process.env.IRIX_UNRESTRICTED = saved;
    if (savedHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = savedHome;
  });

  it("stores the guide in the config it persists, and sends it once in the first prompt", async () => {
    const session = (await client().createSession(
      { provider: "devin", cwd: "/w", systemPrompt: "You are Zed." } as never,
      { agentId: "agent-1" } as never,
    )) as { connection: { prompt: (p: unknown) => Promise<unknown> } };
    const config = calls[0]?.[0] as { daemonAppendSystemPrompt: string };
    expect(config.daemonAppendSystemPrompt).toContain("irix agent ls");
    expect(config.daemonAppendSystemPrompt).toContain("agent-1");

    await session.connection.prompt({ prompt: [{ type: "text", text: "hi" }] });
    const sent = prompts[0]?.prompt[0]?.text ?? "";
    expect(sent).toBe(instructionBlock(`You are Zed.\n\n${config.daemonAppendSystemPrompt}`).text);
    expect(sent.match(/irix agent ls/g)).toHaveLength(1);
  });

  it("is taught the MCP route, with no command-line guide, while the setting is MCP", async () => {
    process.env.IRIX_UNRESTRICTED = "1";
    setAgentToolsChannel("mcp");
    await client().createSession(
      { provider: "devin", cwd: "/w" } as never,
      {
        agentId: "agent-1",
      } as never,
    );
    const config = calls[0]?.[0] as { daemonAppendSystemPrompt?: string };
    expect(config.daemonAppendSystemPrompt ?? "").not.toContain("irix agent ls");
  });

  it("keeps what it was created with when resumed: no MCP server for a command-line agent", async () => {
    process.env.IRIX_UNRESTRICTED = "1";
    setAgentToolsChannel("mcp");
    rememberAgentManagerForGuide(ENDPOINT);
    const created = "Working with other agents in this app: you have no MCP tools for it.";
    await client().resumeSession(
      {
        provider: "devin",
        sessionId: "s",
        metadata: { daemonAppendSystemPrompt: created },
      } as never,
      {
        daemonAppendSystemPrompt: "House rules.",
        mcpServers: {
          paseo: { type: "http", url: "http://x" },
          other: { type: "http", url: "http://y" },
        },
      } as never,
      { agentId: "agent-1" } as never,
    );
    const overrides = calls[0]?.[1] as {
      daemonAppendSystemPrompt: string;
      mcpServers: Record<string, unknown>;
    };
    expect(overrides.daemonAppendSystemPrompt).toBe(created);
    expect(Object.keys(overrides.mcpServers)).toEqual(["other"]);
  });

  it("gives an agent created over MCP a fresh MCP server even while the setting is the command line", async () => {
    rememberAgentManagerForGuide(ENDPOINT);
    await client().resumeSession(
      { provider: "devin", sessionId: "s", metadata: {} } as never,
      {} as never,
      { agentId: "agent-1" } as never,
    );
    const overrides = calls[0]?.[1] as {
      mcpServers: Record<string, { headers?: { Authorization?: string } }>;
    };
    expect(overrides.mcpServers.paseo?.headers?.Authorization).toBe("Bearer fresh-token");
  });
});
