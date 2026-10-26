import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeAgentClient } from "../server/agent/providers/claude/agent.js";
import { resetAgentToolsForTests, setAgentToolsChannel } from "./agent-tools-setting.js";
import { rememberAgentManagerForGuide, resetAgentManagerForTests } from "./agent-tools-resume.js";
import { installClaudeAgentGuide, resetClaudeAgentGuideForTests } from "./claude-agent-guide.js";
import { activateIrixPolicy } from "./policy.js";

type Method = (...args: unknown[]) => Promise<unknown>;
type Proto = Record<"createSession" | "resumeSession", Method>;

const proto = ClaudeAgentClient.prototype as unknown as Proto;
const real = { create: proto.createSession, resume: proto.resumeSession };

describe("Claude's system prompt carries the agent guide", () => {
  let deactivate: () => void;
  let calls: unknown[][];
  const savedUnrestricted = process.env.IRIX_UNRESTRICTED;
  const savedHome = process.env.PASEO_HOME;

  beforeEach(() => {
    delete process.env.IRIX_UNRESTRICTED;
    delete process.env.PASEO_HOME;
    calls = [];
    proto.createSession = async (...args: unknown[]) => calls.push(args);
    proto.resumeSession = async (...args: unknown[]) => calls.push(args);
    resetClaudeAgentGuideForTests();
    resetAgentManagerForTests();
    resetAgentToolsForTests();
    deactivate = activateIrixPolicy();
  });

  afterEach(() => {
    deactivate();
    proto.createSession = real.create;
    proto.resumeSession = real.resume;
    resetClaudeAgentGuideForTests();
    resetAgentToolsForTests();
    if (savedUnrestricted === undefined) delete process.env.IRIX_UNRESTRICTED;
    else process.env.IRIX_UNRESTRICTED = savedUnrestricted;
    if (savedHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = savedHome;
  });

  it("appends the guide after the daemon's own text when a session is created", async () => {
    installClaudeAgentGuide();
    installClaudeAgentGuide();
    await proto.createSession.call(
      {},
      { provider: "claude", cwd: "/w", daemonAppendSystemPrompt: "House rules." },
      { agentId: "agent-1" },
    );
    const config = calls[0]?.[0] as { daemonAppendSystemPrompt: string; cwd: string };
    expect(config.cwd).toBe("/w");
    expect(config.daemonAppendSystemPrompt.startsWith("House rules.\n\n")).toBe(true);
    expect(config.daemonAppendSystemPrompt).toContain("irix agent ls");
    expect(config.daemonAppendSystemPrompt).toContain("agent-1");
    expect(config.daemonAppendSystemPrompt.match(/irix agent ls/g)).toHaveLength(1);
  });

  describe("a resumed session keeps what its agent was created with", () => {
    const ENDPOINT = {
      mcpBaseUrl: "http://127.0.0.1:6931/mcp/agents",
      mcpAuthToken: "fresh-token",
    };
    const staleServer = {
      type: "http",
      url: "http://127.0.0.1:6931/mcp/agents?callerAgentId=a",
      headers: { Authorization: "Bearer stale" },
    };
    const resume = async (
      metadata: Record<string, unknown>,
      overrides?: Record<string, unknown>,
    ) => {
      await proto.resumeSession.call({}, { sessionId: "s", metadata }, overrides, { agentId: "a" });
      return calls[0]?.[1] as {
        daemonAppendSystemPrompt?: string;
        mcpServers?: Record<string, { headers?: { Authorization?: string } }>;
      };
    };

    it("passes the guide it was created with through unchanged, and gives it no MCP server", async () => {
      process.env.IRIX_UNRESTRICTED = "1";
      setAgentToolsChannel("mcp");
      installClaudeAgentGuide();
      rememberAgentManagerForGuide(ENDPOINT);
      const created = "Working with other agents in this app: use the `irix` command.";
      const overrides = await resume(
        {
          daemonAppendSystemPrompt: created,
          mcpServers: { paseo: staleServer, other: { type: "http", url: "http://x" } },
        },
        {
          daemonAppendSystemPrompt: "House rules.",
          mcpServers: { paseo: staleServer, other: { type: "http", url: "http://x" } },
        },
      );
      expect(overrides.daemonAppendSystemPrompt).toBe(created);
      expect(Object.keys(overrides.mcpServers ?? {})).toEqual(["other"]);
    });

    it("gives an agent created over MCP a fresh MCP server, even while the setting is the command line", async () => {
      installClaudeAgentGuide();
      const policies = new Map([["a", { enabled: false, disabledTools: ["x"] }]]);
      rememberAgentManagerForGuide({ ...ENDPOINT, paseoToolPolicies: policies });
      const overrides = await resume(
        {
          daemonAppendSystemPrompt: "POLICY - MANDATORY SUBAGENT APPROVAL: wait.",
          mcpServers: { paseo: staleServer },
        },
        {},
      );
      expect(overrides.daemonAppendSystemPrompt).toBe(
        "POLICY - MANDATORY SUBAGENT APPROVAL: wait.",
      );
      expect(overrides.mcpServers?.paseo?.headers?.Authorization).toBe("Bearer fresh-token");
      expect(policies.get("a")).toEqual({ enabled: true, disabledTools: ["x"] });
    });

    it("leaves an agent created in the command-line mode with its tool policy as the manager set it", async () => {
      installClaudeAgentGuide();
      const policies = new Map([["a", { enabled: true }]]);
      rememberAgentManagerForGuide({ ...ENDPOINT, paseoToolPolicies: policies });
      await resume({ daemonAppendSystemPrompt: "Working with other agents in this app: x" }, {});
      expect(policies.get("a")).toEqual({ enabled: true });
    });

    it("treats an agent with no stored guide as one created over MCP", async () => {
      installClaudeAgentGuide();
      rememberAgentManagerForGuide(ENDPOINT);
      const overrides = await resume({}, { daemonAppendSystemPrompt: "House rules." });
      expect(overrides.daemonAppendSystemPrompt).toBe("House rules.");
      expect(overrides.mcpServers?.paseo?.headers?.Authorization).toBe("Bearer fresh-token");
    });

    it("adds no server when the daemon has no MCP address", async () => {
      installClaudeAgentGuide();
      rememberAgentManagerForGuide({ mcpBaseUrl: null, mcpAuthToken: null });
      const overrides = await resume({ mcpServers: { paseo: staleServer } }, {});
      expect(overrides.mcpServers).toEqual({});
    });
  });

  it("leaves the commands out when the host hands the tools over MCP", async () => {
    process.env.IRIX_UNRESTRICTED = "1";
    setAgentToolsChannel("mcp");
    installClaudeAgentGuide();
    await proto.createSession.call({}, { provider: "claude", cwd: "/w" }, { agentId: "a" });
    const config = calls[0]?.[0] as { daemonAppendSystemPrompt?: string };
    expect(config.daemonAppendSystemPrompt ?? "").not.toContain("irix agent ls");
  });

  it("does nothing outside an Irix edition", async () => {
    deactivate();
    installClaudeAgentGuide();
    deactivate = activateIrixPolicy();
    await proto.createSession.call({}, { provider: "claude", cwd: "/w" }, { agentId: "a" });
    expect(calls[0]?.[0]).toEqual({ provider: "claude", cwd: "/w" });
  });

  it("still finds the MCP address and token on upstream's agent manager", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../server/agent/agent-manager.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("private mcpBaseUrl: string | null;");
    expect(source).toContain("private readonly mcpAuthToken: string | null;");
    expect(source).toContain("private readonly paseoToolPolicies = new Map<");
  });
});
