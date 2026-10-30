import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activateIrixPolicy } from "./policy.js";
import { attachIrixWsServer, resetSubagentApprovalCacheForTests } from "./subagent-approval.js";

const VARIABLES = [
  "PASEO_HOME",
  "IRIX_UNRESTRICTED",
  "IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL",
] as const;

// The daemon's config store as attachIrixWsServer sees it: the same shape upstream gives it, with
// `patch` returning a promise since v0.14.0.
describe("the subagent approval switch in the daemon config store", () => {
  let home: string;
  let deactivate: () => void;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of VARIABLES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    home = mkdtempSync(path.join(tmpdir(), "subagent-config-"));
    process.env.PASEO_HOME = home;
    resetSubagentApprovalCacheForTests(null);
    deactivate = activateIrixPolicy();
  });

  afterEach(() => {
    deactivate();
    resetSubagentApprovalCacheForTests(null);
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
    rmSync(home, { recursive: true, force: true });
  });

  const configPath = () => path.join(home, "daemon.json");

  function attachStore() {
    const innerPatch = vi.fn(async (patch: Record<string, unknown>) => {
      await new Promise((resolve) => setImmediate(resolve));
      return { base: true, ...patch };
    });
    const store = {
      get: (): Record<string, unknown> => ({ base: true }),
      patch: innerPatch,
    };
    const broadcastConfig = vi.fn();
    const broadcastCapabilities = vi.fn();
    const ws = {
      paseoHome: home,
      daemonConfigStore: store,
      broadcastDaemonConfigChanged: broadcastConfig,
      broadcastCapabilitiesUpdate: broadcastCapabilities,
    };
    attachIrixWsServer(ws);
    return { store, innerPatch, broadcastConfig, broadcastCapabilities };
  }

  it("reports the switch as required and locked on a host that does not allow changing it", () => {
    const { store } = attachStore();
    expect(store.get()).toMatchObject({
      base: true,
      requireSubagentApproval: true,
      subagentApprovalLocked: true,
    });
  });

  it("reports the lock as off on a host that allows changing the switch", () => {
    process.env.IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL = "1";
    const { store } = attachStore();
    expect(store.get()).toMatchObject({
      requireSubagentApproval: true,
      subagentApprovalLocked: false,
    });
  });

  it("reads a switch turned off in daemon.json when the host allows changing it", () => {
    process.env.IRIX_UNRESTRICTED = "1";
    writeFileSync(configPath(), JSON.stringify({ requireSubagentApproval: false }), "utf8");
    const { store } = attachStore();
    expect(store.get()).toMatchObject({
      requireSubagentApproval: false,
      subagentApprovalLocked: false,
    });
  });

  it("writes a patch that turns the switch off to daemon.json, and the result and get() show it", async () => {
    process.env.IRIX_UNRESTRICTED = "1";
    const { store } = attachStore();

    const result = await store.patch({ requireSubagentApproval: false });

    // The agent-tools wrapper also adds its fields to the same store; only these two are checked here.
    expect(result).toMatchObject({
      base: true,
      requireSubagentApproval: false,
      subagentApprovalLocked: false,
    });
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(raw.requireSubagentApproval).toBe(false);
    expect(raw.daemon.requireSubagentApproval).toBe(false);
    expect(store.get()).toMatchObject({ requireSubagentApproval: false });
  });

  it("passes the rest of the patch to upstream and merges what it returns", async () => {
    process.env.IRIX_UNRESTRICTED = "1";
    const { store, innerPatch } = attachStore();

    const result = await store.patch({ requireSubagentApproval: true, theme: "dark" });

    expect(innerPatch).toHaveBeenCalledWith({ requireSubagentApproval: true, theme: "dark" });
    expect(result).toMatchObject({ base: true, theme: "dark", requireSubagentApproval: true });
  });

  it("broadcasts a change of the switch to capabilities and to the config, and nothing else", async () => {
    process.env.IRIX_UNRESTRICTED = "1";
    const { store, broadcastConfig, broadcastCapabilities } = attachStore();

    await store.patch({ requireSubagentApproval: false });
    expect(broadcastCapabilities).toHaveBeenCalledTimes(1);
    expect(broadcastConfig).toHaveBeenCalledTimes(1);
    expect(broadcastConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        base: true,
        requireSubagentApproval: false,
        subagentApprovalLocked: false,
      }),
    );

    await store.patch({ theme: "dark" });
    expect(broadcastCapabilities).toHaveBeenCalledTimes(1);
    expect(broadcastConfig).toHaveBeenCalledTimes(1);
  });

  it("refuses to turn the switch off on a locked host, and does not touch the store or the file", async () => {
    const { store, innerPatch, broadcastConfig } = attachStore();

    await expect(store.patch({ requireSubagentApproval: false })).rejects.toThrow();
    expect(innerPatch).not.toHaveBeenCalled();
    expect(broadcastConfig).not.toHaveBeenCalled();
    expect(existsSync(configPath())).toBe(false);
    expect(store.get()).toMatchObject({
      requireSubagentApproval: true,
      subagentApprovalLocked: true,
    });
  });

  it("wraps the store once, however many times it is attached", async () => {
    process.env.IRIX_UNRESTRICTED = "1";
    const store = {
      get: (): Record<string, unknown> => ({ base: true }),
      patch: vi.fn(async (patch: Record<string, unknown>) => ({ base: true, ...patch })),
    };
    const broadcastConfig = vi.fn();
    const ws = {
      paseoHome: home,
      daemonConfigStore: store,
      broadcastDaemonConfigChanged: broadcastConfig,
      broadcastCapabilitiesUpdate: vi.fn(),
    };
    attachIrixWsServer(ws);
    attachIrixWsServer(ws);

    await store.patch({ requireSubagentApproval: false });
    expect(broadcastConfig).toHaveBeenCalledTimes(1);
  });
});
