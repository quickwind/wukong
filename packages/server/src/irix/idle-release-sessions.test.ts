import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wrapSessionProvider } from "../server/agent/provider-registry.js";
import { ACPAgentClient } from "../server/agent/providers/acp-agent.js";
import { ClaudeAgentClient } from "../server/agent/providers/claude/agent.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { hasRunningClaudeBackgroundShell } from "./idle-release-busy.js";
import {
  installIdleReleaseSessionHooks,
  rawSessionFor,
  registerRawSession,
  resetIdleReleaseSessionsForTests,
} from "./idle-release-sessions.js";
import { activateIrixPolicy } from "./policy.js";

type Method = (...args: unknown[]) => Promise<unknown>;
type Proto = Record<"createSession" | "resumeSession", Method>;

const claudeProto = ClaudeAgentClient.prototype as unknown as Proto;
const acpProto = ACPAgentClient.prototype as unknown as Proto;
const realMethods = {
  claudeCreate: claudeProto.createSession,
  claudeResume: claudeProto.resumeSession,
  acpCreate: acpProto.createSession,
  acpResume: acpProto.resumeSession,
};

function restorePrototypes(): void {
  claudeProto.createSession = realMethods.claudeCreate;
  claudeProto.resumeSession = realMethods.claudeResume;
  acpProto.createSession = realMethods.acpCreate;
  acpProto.resumeSession = realMethods.acpResume;
}

function fakeRaw() {
  return {
    translateMessageToEvents(_m: unknown) {
      return ["ok"];
    },
  };
}

describe("raw session registry", () => {
  afterEach(() => {
    resetIdleReleaseSessionsForTests();
  });

  it("resolves the session registered under an agent id, and the latest one wins", () => {
    const first = {};
    const second = {};
    registerRawSession("a", first);
    expect(rawSessionFor("a")).toBe(first);
    registerRawSession("a", second);
    expect(rawSessionFor("a")).toBe(second);
    expect(rawSessionFor("b")).toBeUndefined();
  });

  it("ignores a missing or empty agent id", () => {
    registerRawSession(undefined, {});
    registerRawSession("", {});
    expect(rawSessionFor("")).toBeUndefined();
  });
});

describe("installIdleReleaseSessionHooks", () => {
  let deactivate: () => void;
  let stubs: Record<keyof typeof realMethods, ReturnType<typeof vi.fn>>;
  let sessions: Record<keyof typeof realMethods, ReturnType<typeof fakeRaw>>;

  beforeEach(() => {
    deactivate = activateIrixPolicy();
    sessions = {
      claudeCreate: fakeRaw(),
      claudeResume: fakeRaw(),
      acpCreate: fakeRaw(),
      acpResume: fakeRaw(),
    };
    stubs = {
      claudeCreate: vi.fn(async () => sessions.claudeCreate),
      claudeResume: vi.fn(async () => sessions.claudeResume),
      acpCreate: vi.fn(async () => sessions.acpCreate),
      acpResume: vi.fn(async () => sessions.acpResume),
    };
    claudeProto.createSession = stubs.claudeCreate as unknown as Method;
    claudeProto.resumeSession = stubs.claudeResume as unknown as Method;
    acpProto.createSession = stubs.acpCreate as unknown as Method;
    acpProto.resumeSession = stubs.acpResume as unknown as Method;
  });

  afterEach(() => {
    deactivate();
    restorePrototypes();
    resetIdleReleaseSessionsForTests();
  });

  it("registers the raw session under the launch-context agent id on create and resume", async () => {
    installIdleReleaseSessionHooks();
    const self = { tag: "client" };
    const config = { provider: "claude" };
    const options = { persistSession: true };
    const created = await claudeProto.createSession.call(self, config, { agentId: "c1" }, options);
    expect(created).toBe(sessions.claudeCreate);
    expect(stubs.claudeCreate).toHaveBeenCalledWith(config, { agentId: "c1" }, options);
    expect(stubs.claudeCreate.mock.contexts[0]).toBe(self);
    expect(rawSessionFor("c1")).toBe(sessions.claudeCreate);

    const handle = { provider: "claude" };
    const resumed = await claudeProto.resumeSession.call(self, handle, {}, { agentId: "c2" });
    expect(resumed).toBe(sessions.claudeResume);
    expect(stubs.claudeResume).toHaveBeenCalledWith(handle, {}, { agentId: "c2" });
    expect(stubs.claudeResume.mock.contexts[0]).toBe(self);
    expect(rawSessionFor("c2")).toBe(sessions.claudeResume);

    const acpCreated = await acpProto.createSession.call(self, config, { agentId: "d1" }, options);
    expect(acpCreated).toBe(sessions.acpCreate);
    expect(stubs.acpCreate.mock.contexts[0]).toBe(self);
    expect(rawSessionFor("d1")).toBe(sessions.acpCreate);

    const acpResumed = await acpProto.resumeSession.call(self, handle, {}, { agentId: "d2" }, {});
    expect(acpResumed).toBe(sessions.acpResume);
    expect(stubs.acpResume).toHaveBeenCalledWith(handle, {}, { agentId: "d2" }, {});
    expect(rawSessionFor("d2")).toBe(sessions.acpResume);
  });

  it("tracks background shells on Claude sessions only", async () => {
    const claudeTranslate = sessions.claudeCreate.translateMessageToEvents;
    const acpTranslate = sessions.acpCreate.translateMessageToEvents;
    installIdleReleaseSessionHooks();
    await claudeProto.createSession.call({}, {}, { agentId: "c" });
    await acpProto.createSession.call({}, {}, { agentId: "d" });
    expect(sessions.claudeCreate.translateMessageToEvents).not.toBe(claudeTranslate);
    expect(hasRunningClaudeBackgroundShell(sessions.claudeCreate)).toBe(false);
    expect(sessions.acpCreate.translateMessageToEvents).toBe(acpTranslate);
  });

  it("puts the subagent ask hook on Claude's real session, and not on a Devin one", async () => {
    const hooks = () => ({ PreToolUse: [{ hooks: [] }] });
    const claude = Object.assign(sessions.claudeCreate, { buildSubagentEffortHooks: hooks });
    const devin = Object.assign(sessions.acpCreate, { buildSubagentEffortHooks: hooks });
    installIdleReleaseSessionHooks();
    await claudeProto.createSession.call({}, {}, { agentId: "c" });
    await acpProto.createSession.call({}, {}, { agentId: "d" });
    expect(claude.buildSubagentEffortHooks).not.toBe(hooks);
    expect(devin.buildSubagentEffortHooks).toBe(hooks);
    const built = claude.buildSubagentEffortHooks() as { PreToolUse: Array<{ matcher?: string }> };
    expect(built.PreToolUse[0]!.matcher).toBe("Task|Agent");
  });

  it("installs once however often it is called", async () => {
    installIdleReleaseSessionHooks();
    const wrapped = claudeProto.createSession;
    installIdleReleaseSessionHooks();
    installIdleReleaseSessionHooks();
    expect(claudeProto.createSession).toBe(wrapped);
    await claudeProto.createSession.call({}, {}, { agentId: "c" });
    expect(stubs.claudeCreate).toHaveBeenCalledTimes(1);
  });

  it("leaves the prototypes untouched when the Irix policy is off", () => {
    deactivate();
    installIdleReleaseSessionHooks();
    expect(claudeProto.createSession).toBe(stubs.claudeCreate);
    expect(claudeProto.resumeSession).toBe(stubs.claudeResume);
    expect(acpProto.createSession).toBe(stubs.acpCreate);
    expect(acpProto.resumeSession).toBe(stubs.acpResume);
  });

  it("a session the hook cannot wrap is still returned, registered and counted as busy", async () => {
    const frozen = Object.freeze(fakeRaw());
    stubs.claudeCreate.mockImplementation(async () => frozen);
    installIdleReleaseSessionHooks();
    await expect(claudeProto.createSession.call({}, {}, { agentId: "f" })).resolves.toBe(frozen);
    expect(rawSessionFor("f")).toBe(frozen);
    expect(hasRunningClaudeBackgroundShell(frozen)).toBe(true);
  });

  it("does not register a session created without a launch context", async () => {
    installIdleReleaseSessionHooks();
    await expect(claudeProto.createSession.call({}, {})).resolves.toBe(sessions.claudeCreate);
    await expect(acpProto.resumeSession.call({}, {}, {})).resolves.toBe(sessions.acpResume);
    expect(rawSessionFor("undefined")).toBeUndefined();
  });
});

describe("installIdleReleaseSessionHooks on the real Claude client", () => {
  let deactivate: () => void;
  afterEach(() => {
    deactivate();
    restorePrototypes();
    resetIdleReleaseSessionsForTests();
  });

  it("registers and tracks the real ClaudeAgentSession, which the facade hides", async () => {
    deactivate = activateIrixPolicy();
    installIdleReleaseSessionHooks();
    const client = new ClaudeAgentClient({ logger: createTestLogger() });
    const raw = await client.createSession({ provider: "claude", cwd: tmpdir() }, { agentId: "r" });
    try {
      expect(raw.constructor.name).toBe("ClaudeAgentSession");
      expect(rawSessionFor("r")).toBe(raw);
      // Tracked: the real session has the private method the tracker wraps.
      expect(hasRunningClaudeBackgroundShell(raw)).toBe(false);
      const facade = wrapSessionProvider("claude", raw);
      expect(hasRunningClaudeBackgroundShell(facade)).toBe(true);
    } finally {
      await raw.close();
    }
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));
function source(rel: string): string {
  return readFileSync(path.join(here, "..", rel), "utf8").replace(/\r\n/g, "\n");
}

describe("the agent id travels in the launch context the hook reads", () => {
  it("AgentManager builds the launch context with the agent id and passes it to every factory", () => {
    const src = source("server/agent/agent-manager.ts");
    expect(src).toContain("const context: AgentLaunchContext = {\n      agentId,");
    expect(src).toContain(
      "const session = await client.createSession(providerLaunchConfig, launchContext, createOptions);",
    );
    expect(src).toContain(
      "? await client.resumeSession(handle, providerLaunchConfig, launchContext)",
    );
    expect(src).toContain(": await client.createSession(providerLaunchConfig, launchContext);");
    expect(src).toContain("{ config: providerLaunchConfig, storedConfig, launchContext },");
  });

  it("the registry and the import helper forward the launch context at the same position", () => {
    const registry = source("server/agent/provider-registry.ts");
    expect(registry).toContain("createSession: async (config, launchContext, options) =>");
    expect(registry).toContain(
      "resumeSession: async (handle, overrides, launchContext, options) =>",
    );
    const importer = source("server/agent/provider-session-import.ts");
    expect(importer).toContain(
      "await input.resumeSession(persistence, config, input.context.launchContext);",
    );
  });

  it("the client classes take the launch context second on create and third on resume", () => {
    for (const rel of [
      "server/agent/providers/claude/agent.ts",
      "server/agent/providers/acp-agent.ts",
    ]) {
      const src = source(rel);
      expect(src).toContain(
        "  async createSession(\n    config: AgentSessionConfig,\n    launchContext?: AgentLaunchContext,",
      );
      expect(src).toContain(
        "  async resumeSession(\n    handle: AgentPersistenceHandle,\n    overrides?: Partial<AgentSessionConfig>,\n    launchContext?: AgentLaunchContext,",
      );
      expect(src).toContain("resumeSession: this.resumeSession.bind(this),");
    }
    const devin = source("irix/devin-client.ts");
    // The config and the overrides are Irix's own versions (guide, MCP choice); the launch context
    // keeps its position, which is what the hook reads.
    expect(devin).toContain("await super.createSession(guided, launchContext, options);");
    expect(devin).toMatch(
      /await super\.resumeSession\(\s*handle,[\s\S]*?,\s*launchContext,\s*options,?\s*\);/u,
    );
  });
});
