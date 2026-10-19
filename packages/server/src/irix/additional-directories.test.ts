import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { ACPAgentSession, type SpawnedACPProcess } from "../server/agent/providers/acp-agent.js";
import { additionalDirectoriesParams } from "./additional-directories.js";

const logger = pino({ level: "silent" });
const ADVERTISED = { sessionCapabilities: { additionalDirectories: {} } };
const BOT = path.resolve("/tmp/bots/ada");
const OTHER = path.resolve("/tmp/bots/grace");

function warnings() {
  const warn = vi.fn();
  return { warn, log: { warn } };
}

describe("additionalDirectoriesParams", () => {
  it("passes absolute directories when the agent advertises the capability", () => {
    const { log } = warnings();
    expect(
      additionalDirectoriesParams({
        providerOptions: { additionalDirectories: [BOT, OTHER] },
        agentCapabilities: ADVERTISED,
        logger: log,
      }),
    ).toEqual({ additionalDirectories: [BOT, OTHER] });
  });

  it("sends nothing when the option is absent", () => {
    const { log, warn } = warnings();
    expect(
      additionalDirectoriesParams({
        providerOptions: undefined,
        agentCapabilities: ADVERTISED,
        logger: log,
      }),
    ).toEqual({});
    expect(
      additionalDirectoriesParams({
        providerOptions: { supportsMcpServers: true },
        agentCapabilities: ADVERTISED,
        logger: log,
      }),
    ).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends nothing when the agent does not advertise the capability", () => {
    const { log } = warnings();
    for (const agentCapabilities of [null, {}, { sessionCapabilities: {} }]) {
      expect(
        additionalDirectoriesParams({
          providerOptions: { additionalDirectories: [BOT] },
          agentCapabilities,
          logger: log,
        }),
      ).toEqual({});
    }
  });

  it("ignores a value that is not an array, and warns", () => {
    const { log, warn } = warnings();
    expect(
      additionalDirectoriesParams({
        providerOptions: { additionalDirectories: BOT },
        agentCapabilities: ADVERTISED,
        logger: log,
      }),
    ).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("drops entries that are not absolute paths, keeps the rest, and warns", () => {
    const { log, warn } = warnings();
    expect(
      additionalDirectoriesParams({
        providerOptions: {
          additionalDirectories: [BOT, "relative/dir", "", 7, null, { path: OTHER }, OTHER, BOT],
        },
        agentCapabilities: ADVERTISED,
        logger: log,
      }),
    ).toEqual({ additionalDirectories: [BOT, OTHER] });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when no entry survives", () => {
    const { log } = warnings();
    expect(
      additionalDirectoriesParams({
        providerOptions: { additionalDirectories: ["nope", 3] },
        agentCapabilities: ADVERTISED,
        logger: log,
      }),
    ).toEqual({});
    expect(
      additionalDirectoriesParams({
        providerOptions: { additionalDirectories: [] },
        agentCapabilities: ADVERTISED,
        logger: log,
      }),
    ).toEqual({});
  });
});

function childStub(): ChildProcessWithoutNullStreams {
  const destroyable = () => ({ destroy: vi.fn(), on: vi.fn(), once: vi.fn(), end: vi.fn() });
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = destroyable() as unknown as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = destroyable() as unknown as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = destroyable() as unknown as ChildProcessWithoutNullStreams["stderr"];
  child.kill = vi.fn(() => true) as ChildProcessWithoutNullStreams["kill"];
  return child;
}

const STATE = { modes: null, models: null, configOptions: [] };

function sessionWith(
  connection: Record<string, unknown>,
  agentCapabilities: Record<string, unknown>,
  providerOptions: Record<string, unknown> | undefined,
) {
  const session = new ACPAgentSession(
    { provider: "devin", cwd: "/tmp/worktree", providerOptions },
    {
      provider: "devin",
      logger,
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
      handle: { provider: "devin", sessionId: "s-1" },
    },
  );
  // The process launch is private to the session; the tests stand in a connection for it.
  (session as unknown as { spawnProcess(): Promise<SpawnedACPProcess> }).spawnProcess = async () =>
    ({
      child: childStub(),
      connection: connection as unknown as ClientSideConnection,
      initialize: { agentCapabilities },
    }) as SpawnedACPProcess;
  return session;
}

describe("ACP session carries additionalDirectories", () => {
  it("sends them in session/new", async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: "s-1", ...STATE });
    const session = sessionWith({ newSession }, ADVERTISED, { additionalDirectories: [BOT] });
    await session.initializeNewSession();
    expect(newSession).toHaveBeenCalledWith({
      cwd: "/tmp/worktree",
      mcpServers: expect.any(Array),
      additionalDirectories: [BOT],
    });
  });

  it("sends only cwd and mcpServers when the option is not given", async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: "s-1", ...STATE });
    const session = sessionWith({ newSession }, ADVERTISED, undefined);
    await session.initializeNewSession();
    const params = newSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(["cwd", "mcpServers"]);
  });

  it("starts the chat anyway when the option is invalid", async () => {
    const newSession = vi.fn().mockResolvedValue({ sessionId: "s-1", ...STATE });
    const session = sessionWith({ newSession }, ADVERTISED, {
      additionalDirectories: "not-a-list",
    });
    await session.initializeNewSession();
    const params = newSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty("additionalDirectories");
  });

  it("sends them again in session/load when the session is resumed", async () => {
    const loadSession = vi.fn().mockResolvedValue(STATE);
    const session = sessionWith(
      { loadSession },
      { loadSession: true, ...ADVERTISED },
      {
        additionalDirectories: [BOT],
      },
    );
    await session.initializeResumedSession();
    expect(loadSession).toHaveBeenCalledWith({
      sessionId: "s-1",
      cwd: "/tmp/worktree",
      mcpServers: expect.any(Array),
      additionalDirectories: [BOT],
    });
  });

  it("sends them again in session/resume for agents that resume without loading", async () => {
    const unstable_resumeSession = vi.fn().mockResolvedValue(STATE);
    const session = sessionWith(
      { unstable_resumeSession },
      { sessionCapabilities: { resume: {}, additionalDirectories: {} } },
      { additionalDirectories: [BOT] },
    );
    await session.initializeResumedSession();
    expect(unstable_resumeSession).toHaveBeenCalledWith({
      sessionId: "s-1",
      cwd: "/tmp/worktree",
      mcpServers: expect.any(Array),
      additionalDirectories: [BOT],
    });
  });
});
