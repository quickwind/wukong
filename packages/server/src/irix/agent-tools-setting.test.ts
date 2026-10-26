import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAgentToolsChannel,
  isAgentToolsEditable,
  resetAgentToolsForTests,
  setAgentToolsChannel,
  wrapAgentToolsConfigStore,
} from "./agent-tools-setting.js";
import { activateIrixPolicy } from "./policy.js";

const VARIABLES = ["PASEO_HOME", "IRIX_UNRESTRICTED", "IRIX_ALLOW_AGENT_TOOLS"] as const;

describe("how agents reach the agent tools", () => {
  let home: string;
  let deactivate: () => void;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of VARIABLES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    home = mkdtempSync(path.join(tmpdir(), "agent-tools-"));
    process.env.PASEO_HOME = home;
    resetAgentToolsForTests();
    deactivate = activateIrixPolicy();
  });

  afterEach(() => {
    deactivate();
    resetAgentToolsForTests();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  const configPath = () => path.join(home, "daemon.json");
  const writeDaemon = (daemon: Record<string, unknown>) =>
    writeFileSync(configPath(), JSON.stringify({ other: 1, daemon }), "utf8");

  it("is the command line, fixed, while the host is restricted, whatever daemon.json says", () => {
    writeDaemon({ agentTools: "mcp" });
    expect(isAgentToolsEditable()).toBe(false);
    expect(getAgentToolsChannel()).toBe("cli");
    expect(() => setAgentToolsChannel("mcp")).toThrow(/fixed/);
  });

  it.each(["IRIX_UNRESTRICTED", "IRIX_ALLOW_AGENT_TOOLS"])(
    "can be changed once %s is set, and is kept in daemon.json",
    (variable) => {
      process.env[variable] = "1";
      expect(isAgentToolsEditable()).toBe(true);
      expect(getAgentToolsChannel()).toBe("cli");
      writeDaemon({ keep: true });
      expect(setAgentToolsChannel("mcp")).toBe("mcp");
      const raw = JSON.parse(readFileSync(configPath(), "utf8"));
      expect(raw.other).toBe(1);
      expect(raw.daemon).toEqual({ keep: true, agentTools: "mcp" });
      resetAgentToolsForTests();
      expect(getAgentToolsChannel()).toBe("mcp");
    },
  );

  it("reads anything but cli or mcp on disk as cli, and refuses it in a patch", () => {
    process.env.IRIX_UNRESTRICTED = "1";
    writeDaemon({ agentTools: "both" });
    expect(getAgentToolsChannel()).toBe("cli");
    expect(() => setAgentToolsChannel("both")).toThrow();
  });

  it("travels in the daemon config, and a change is broadcast", () => {
    process.env.IRIX_UNRESTRICTED = "1";
    const broadcastConfig = vi.fn();
    const broadcastCapabilities = vi.fn();
    const store = {
      get: (): object => ({ base: true }),
      patch: (p: Record<string, unknown>): object => ({ base: true, ...p }),
    };
    const ws = {
      daemonConfigStore: store,
      broadcastDaemonConfigChanged: broadcastConfig,
      broadcastCapabilitiesUpdate: broadcastCapabilities,
    };
    wrapAgentToolsConfigStore(ws);
    wrapAgentToolsConfigStore(ws);

    expect(store.get()).toMatchObject({
      base: true,
      agentTools: "cli",
      agentToolsEditable: true,
    });
    expect(store.patch({ agentTools: "mcp" })).toMatchObject({ agentTools: "mcp" });
    expect(broadcastConfig).toHaveBeenCalledTimes(1);
    expect(broadcastCapabilities).toHaveBeenCalledTimes(1);

    store.patch({ other: 1 });
    expect(broadcastConfig).toHaveBeenCalledTimes(1);
  });

  it("takes Paseo's MCP tools away from Claude and Devin only while the channel is the command line", () => {
    process.env.IRIX_UNRESTRICTED = "1";
    const store = {
      get: (): object => ({
        providers: { claude: { paseoTools: { disabledTools: ["x"] } }, codex: {} },
      }),
      patch: (p: Record<string, unknown>): object => p,
    };
    wrapAgentToolsConfigStore({ daemonConfigStore: store });
    const cli = store.get() as { providers: Record<string, { paseoTools?: object }> };
    expect(cli.providers.claude?.paseoTools).toEqual({ disabledTools: ["x"], enabled: false });
    expect(cli.providers.devin?.paseoTools).toEqual({ enabled: false });
    expect(cli.providers.codex).toEqual({});

    setAgentToolsChannel("mcp");
    const mcp = store.get() as { providers: Record<string, { paseoTools?: object }> };
    expect(mcp.providers.claude?.paseoTools).toEqual({ disabledTools: ["x"] });
    expect(mcp.providers.devin).toBeUndefined();
  });
});
