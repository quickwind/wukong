// Daemon-level acceptance of the Irix restrictions in changes-from-upstream.md (section B), read
// through the public client against a real in-process daemon. Every IRIX_* variable a test needs is
// set and restored with vi.stubEnv, so the result does not depend on the runner's shell.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDaemonTestContext, type DaemonTestContext } from "../server/test-utils/index.js";
import { resetAgentToolsForTests } from "./agent-tools-setting.js";
import { EgressBlockedError, installEgressGuard } from "./egress-guard.js";
import { activateIrixPolicy } from "./policy.js";
import { ForgeRegistry } from "../services/forge-registry.js";
import { createIrixGitLabAdapter, irixForgeEntries } from "./gitlab/adapter.js";
import {
  assertIrixModeAllowed,
  irixFeatures,
  irixServerFeatures,
  isIrixToolBlocked,
  withoutIrixBypassModes,
} from "./restrictions.js";
import { getAskModeConfig } from "../server/daemon-e2e/agent-configs.js";
import { resetSubagentApprovalCacheForTests } from "./subagent-approval.js";

// Every variable that changes an Irix restriction. Each test states the ones it needs; the rest
// are unset, which is the default edition.
const IRIX_ENV_NAMES = [
  "IRIX_UNRESTRICTED",
  "IRIX_ALLOW_SCHEDULES",
  "IRIX_ALLOW_AGENT_MESSAGING",
  "IRIX_ALLOW_BYPASS_MODES",
  "IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL",
  "IRIX_ALLOW_AGENT_TOOLS",
  "IRIX_ENABLE_CONNECTED_HOSTS",
  "IRIX_ALLOWED_HOSTS",
] as const;

let ctx: DaemonTestContext | null = null;
let deactivate: (() => void) | null = null;
let cwd: string | null = null;

function stubIrixEnv(on: Partial<Record<(typeof IRIX_ENV_NAMES)[number], string>> = {}): void {
  for (const name of IRIX_ENV_NAMES) {
    vi.stubEnv(name, on[name]);
  }
}

/**
 * The policy is switched on before the daemon is built: the provider registry is filtered when it
 * is built, so only the Irix providers are registered. Restrictions read the environment at
 * request time, so they follow the variables stubbed for the test.
 */
async function startIrixDaemon(
  on: Partial<Record<(typeof IRIX_ENV_NAMES)[number], string>> = {},
): Promise<DaemonTestContext> {
  stubIrixEnv(on);
  deactivate = activateIrixPolicy();
  resetSubagentApprovalCacheForTests(null);
  resetAgentToolsForTests();
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "irix-acceptance-"));
  return ctx;
}

/**
 * For paths that need a live agent. The daemon is built before the policy is switched on: with the
 * policy on, the provider registry loses the fake provider ("codex" in the test harness), and
 * Claude/Devin would need real CLIs. Restrictions are read per request, so they still apply.
 */
async function startIrixDaemonWithFakeProvider(
  on: Partial<Record<(typeof IRIX_ENV_NAMES)[number], string>> = {},
): Promise<{ ctx: DaemonTestContext; agentId: string }> {
  stubIrixEnv(on);
  resetSubagentApprovalCacheForTests(null);
  resetAgentToolsForTests();
  ctx = await createDaemonTestContext();
  deactivate = activateIrixPolicy();
  cwd = mkdtempSync(path.join(tmpdir(), "irix-acceptance-"));
  const agent = await ctx.client.createAgent({
    config: { ...getAskModeConfig("codex"), cwd },
    initialPrompt: "Say done.",
  });
  await ctx.client.waitForFinish(agent.id, 10000);
  return { ctx, agentId: agent.id };
}

beforeEach(() => {
  ctx = null;
  deactivate = null;
  cwd = null;
});

afterEach(async () => {
  await ctx?.cleanup();
  deactivate?.();
  vi.unstubAllEnvs();
  resetSubagentApprovalCacheForTests(null);
  resetAgentToolsForTests();
  if (cwd) {
    try {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Windows holds the directory while the daemon's watcher closes; it is a temp dir.
    }
  }
});

// The daemon-side refusals are returned as an RPC error or as a payload `error`, depending on the
// request. Collect either form as one message.
async function refusalOf(request: Promise<unknown>): Promise<string> {
  try {
    const payload = (await request) as { error?: string | null } | undefined;
    return payload?.error ?? "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("Irix acceptance: daemon config", { timeout: 60_000 }, () => {
  it("A8 idle release: idleRuntimeCleanup persists and reads back", async () => {
    const { client } = await startIrixDaemon();

    const patched = await client.patchDaemonConfig({ idleRuntimeCleanup: false });
    expect(patched.config.idleRuntimeCleanup).toBe(false);

    const read = await client.getDaemonConfig();
    expect(read.config.idleRuntimeCleanup).toBe(false);
  });

  it("B12 subagent approval: the setting can be turned off only with IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL", async () => {
    const { client } = await startIrixDaemon({ IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL: "1" });

    await client.patchDaemonConfig({ requireSubagentApproval: false });
    expect((await client.getDaemonConfig()).config.requireSubagentApproval).toBe(false);

    await client.patchDaemonConfig({ requireSubagentApproval: true });
    expect((await client.getDaemonConfig()).config.requireSubagentApproval).toBe(true);
  });

  it("B12 subagent approval: the setting is locked on when IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL is unset", async () => {
    const { client } = await startIrixDaemon();

    // The refusal text is the daemon's own (Chinese) message; it is matched as-is.
    expect(await refusalOf(client.patchDaemonConfig({ requireSubagentApproval: false }))).toContain(
      "Mandatory subagent approval is locked",
    );
    const read = await client.getDaemonConfig();
    expect(read.config.requireSubagentApproval).toBe(true);
    expect(read.config.subagentApprovalLocked).toBe(true);
  });

  it("B13 agent tools: agentTools changes persist with IRIX_ALLOW_AGENT_TOOLS", async () => {
    const { client } = await startIrixDaemon({ IRIX_ALLOW_AGENT_TOOLS: "1" });

    await client.patchDaemonConfig({ agentTools: "mcp" } as Parameters<
      typeof client.patchDaemonConfig
    >[0]);
    const read = (await client.getDaemonConfig()).config as unknown as {
      agentTools: string;
      agentToolsEditable: boolean;
    };
    expect(read.agentTools).toBe("mcp");
    expect(read.agentToolsEditable).toBe(true);
  });

  it("B13 agent tools: the change is refused and the setting stays cli without IRIX_ALLOW_AGENT_TOOLS", async () => {
    const { client } = await startIrixDaemon();

    expect(
      await refusalOf(
        client.patchDaemonConfig({ agentTools: "mcp" } as Parameters<
          typeof client.patchDaemonConfig
        >[0]),
      ),
    ).toMatch(/fixed on this daemon/);
    const read = (await client.getDaemonConfig()).config as unknown as {
      agentTools: string;
      agentToolsEditable: boolean;
    };
    expect(read.agentTools).toBe("cli");
    expect(read.agentToolsEditable).toBe(false);
  });
});

describe("Irix acceptance: providers and server features", { timeout: 60_000 }, () => {
  it("B6 providers: only claude and devin are registered", async () => {
    const { client } = await startIrixDaemon();

    const snapshot = await client.getProvidersSnapshot({ cwd: cwd ?? undefined });
    const ids = new Set(snapshot.entries.map((entry) => entry.provider));

    for (const id of ids) {
      expect(["claude", "devin"]).toContain(id);
    }
    for (const other of ["codex", "opencode", "copilot", "gemini", "pi", "fake"]) {
      expect(ids.has(other as never)).toBe(false);
    }
  });

  it("B5 connected hosts: server_info reports connected hosts and host multiplexing off", async () => {
    const { client } = await startIrixDaemon();

    const info = client.getLastServerInfoMessage();
    expect(info?.features?.connectedHosts).toBe(false);
    expect(info?.features?.hostMultiplexing).toBe(false);
  });

  it("B11 bypass modes: a claude agent with a bypass mode is refused without IRIX_ALLOW_BYPASS_MODES", async () => {
    const { client } = await startIrixDaemon();

    // The bypass mode is not in the mode list, so the request is refused as an invalid mode before
    // any session starts: no Claude process or model call is made.
    const modes = await client.listProviderModes("claude", { cwd: cwd ?? undefined });
    expect(modes.modes.map((mode) => mode.id)).not.toContain("bypassPermissions");
    await expect(
      client.createAgent({
        config: { provider: "claude", cwd: cwd ?? "/tmp", modeId: "bypassPermissions" },
        initialPrompt: "Say done.",
      }),
    ).rejects.toThrow(/Invalid mode 'bypassPermissions' for provider 'claude'/);
  });
});

describe("Irix acceptance: schedules and self-update", { timeout: 60_000 }, () => {
  it("B9 schedules are refused without IRIX_ALLOW_SCHEDULES", async () => {
    const { client } = await startIrixDaemon();

    const error = await refusalOf(
      client.scheduleCreate({
        prompt: "check things",
        cadence: { type: "cron", expression: "0 9 * * *" },
        target: {
          type: "new-agent",
          config: { provider: "claude", cwd: cwd ?? "/tmp", isolation: "local" },
        },
      } as Parameters<typeof client.scheduleCreate>[0]),
    );

    expect(error).toContain("Schedules are not available on this daemon.");
    expect((await client.scheduleList()).schedules).toEqual([]);
  });

  it("B4 update daemon: the request is refused", async () => {
    const { client } = await startIrixDaemon();

    const payload = await client.updateDaemon();

    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/Irix does not update itself/);
  });
});

// The guard patches net.Socket.prototype.connect for this test process. It is installed only for
// this describe, on a throwaway socket, and removed in afterEach. The daemon is not started with it
// on: the daemon entry (edition.ts) installs it at real launch, not in the test harness.
describe("Irix acceptance: egress guard", () => {
  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    uninstall = installEgressGuard();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("B1 egress: a connection to a non-loopback host is refused", async () => {
    // 203.0.113.0/24 is TEST-NET-3, documentation space that is never routed.
    const socket = net.connect({ host: "203.0.113.1", port: 443 });
    const error = await new Promise<Error>((resolve) => {
      socket.once("error", resolve);
      socket.once("connect", () => resolve(new Error("connected")));
    });
    socket.destroy();

    expect(error).toBeInstanceOf(EgressBlockedError);
    expect(error.message).toContain("Irix blocked a connection to 203.0.113.1:443");
  });
});

describe(
  "Irix acceptance: agent messaging, bypass modes, cloud features, forges",
  {
    timeout: 90_000,
  },
  () => {
    // Real daemon path: Session.handleSendAgentMessageRequest calls assertIrixAgentMessagingAllowed
    // with the request's sourceAgentId, which is what `irix send` sets when an agent calls it.
    it("B10 agent messaging: a message sent on behalf of an agent is refused, a person's is not", async () => {
      const { ctx: daemon, agentId } = await startIrixDaemonWithFakeProvider();

      const refusal = await refusalOf(
        daemon.client.sendAgentMessage(agentId, "hello from another agent", {
          sourceAgentId: "some-calling-agent",
        }),
      );
      expect(refusal).toContain("Messages between agents are not available on this daemon.");

      await daemon.client.sendAgentMessage(agentId, "hello from a person");
      await daemon.client.waitForFinish(agentId, 10000);
    });

    it("B10 agent messaging: IRIX_ALLOW_AGENT_MESSAGING lifts the refusal", async () => {
      const { ctx: daemon, agentId } = await startIrixDaemonWithFakeProvider({
        IRIX_ALLOW_AGENT_MESSAGING: "1",
      });

      const refusal = await refusalOf(
        daemon.client.sendAgentMessage(agentId, "hello", { sourceAgentId: "some-calling-agent" }),
      );
      expect(refusal).not.toContain("Messages between agents");
    });

    // The agent tool gate (what the MCP/agent tool list is filtered with) is a pure function of the
    // environment; the daemon only calls it while building a tool list for an agent.
    it("B10 agent tools: the tool gate hides send_agent_prompt, schedule and host tools by default", async () => {
      await startIrixDaemon();

      for (const tool of [
        "send_agent_prompt",
        "create_schedule",
        "create_heartbeat",
        "list_schedules",
        "list_hosts",
      ]) {
        expect(isIrixToolBlocked(tool), tool).toBe(true);
      }
      expect(isIrixToolBlocked("list_agents")).toBe(false);
    });

    it("B10 agent tools: IRIX_UNRESTRICTED lifts messaging and schedule blocks, not connected hosts", async () => {
      await startIrixDaemon({ IRIX_UNRESTRICTED: "1" });

      expect(isIrixToolBlocked("send_agent_prompt")).toBe(false);
      expect(isIrixToolBlocked("create_schedule")).toBe(false);
      expect(isIrixToolBlocked("list_hosts")).toBe(true);
    });

    // Through the daemon: setAgentMode runs assertIrixModeAllowed before the provider is touched, so
    // a bypass id that the provider's catalog does list ("full-access" in the fake provider) reaches
    // the Irix check itself instead of being filtered out as an unknown mode.
    it("B11 bypass modes: assertIrixModeAllowed refuses a catalog bypass mode and auto_accept via the daemon", async () => {
      const { ctx: daemon, agentId } = await startIrixDaemonWithFakeProvider();

      expect(await refusalOf(daemon.client.setAgentMode(agentId, "full-access"))).toContain(
        "Bypass permission modes are not available on this daemon.",
      );
      expect(
        await refusalOf(daemon.client.setAgentFeature(agentId, "auto_accept", true)),
      ).toContain("Bypass permission modes are not available on this daemon.");
    });

    it("B11 bypass modes: IRIX_ALLOW_BYPASS_MODES lets the same requests past the Irix check", async () => {
      const { ctx: daemon, agentId } = await startIrixDaemonWithFakeProvider({
        IRIX_ALLOW_BYPASS_MODES: "1",
      });

      expect(await refusalOf(daemon.client.setAgentMode(agentId, "full-access"))).not.toContain(
        "Bypass permission modes",
      );
    });

    it("B11 bypass modes: assertIrixModeAllowed and the mode and feature lists, called in-process", async () => {
      await startIrixDaemon();

      for (const modeId of [
        "bypassPermissions",
        "yolo",
        "full-access",
        "dangerously-skip-permissions",
      ]) {
        expect(() => assertIrixModeAllowed({ modeId }), modeId).toThrow(/Bypass permission modes/);
      }
      expect(() => assertIrixModeAllowed({ featureValues: { auto_accept: true } })).toThrow(
        /Bypass permission modes/,
      );
      expect(() => assertIrixModeAllowed({ modeId: "default" })).not.toThrow();
      expect(() => assertIrixModeAllowed({ featureValues: { auto_accept: false } })).not.toThrow();

      expect(
        withoutIrixBypassModes([
          { id: "default" },
          { id: "bypassPermissions" },
          { id: "plan" },
        ])?.map((mode) => mode.id),
      ).toEqual(["default", "plan"]);
      // The ACP/Claude "Auto accept" feature is left out of the feature list when restricted.
      expect(irixFeatures({ id: "auto_accept" })).toEqual([]);
    });

    it("B11 bypass modes: nothing is refused or hidden with IRIX_ALLOW_BYPASS_MODES", async () => {
      await startIrixDaemon({ IRIX_ALLOW_BYPASS_MODES: "1" });

      expect(() => assertIrixModeAllowed({ modeId: "bypassPermissions" })).not.toThrow();
      expect(() => assertIrixModeAllowed({ featureValues: { auto_accept: true } })).not.toThrow();
      expect(irixFeatures({ id: "auto_accept" })).toEqual([{ id: "auto_accept" }]);
    });

    // The code sets only these flags; relay, pairing, hub and speech have no server_info flag in
    // irixServerFeatures, so there is nothing to assert for them here.
    it("B2/B3 cloud features: server_info carries every flag irixServerFeatures sets", async () => {
      const { client, daemon } = await startIrixDaemon();

      const features = client.getLastServerInfoMessage()?.features;
      expect(features?.connectedHosts).toBe(false);
      expect(features?.hostMultiplexing).toBe(false);
      expect(features?.schedulesDisabled).toBe(true);
      expect(features?.subagentApprovalLocked).toBe(true);
      expect(features?.requireSubagentApproval).toBe(true);
      expect(irixServerFeatures()).toEqual({
        connectedHosts: false,
        hostMultiplexing: false,
        schedulesDisabled: true,
        subagentApprovalLocked: true,
        requireSubagentApproval: true,
      });
      expect(daemon).toBeTruthy();
    });

    it("B2/B3 cloud features: IRIX_ALLOW_SCHEDULES and IRIX_ENABLE_CONNECTED_HOSTS drop their flags", async () => {
      await startIrixDaemon({ IRIX_ALLOW_SCHEDULES: "1", IRIX_ENABLE_CONNECTED_HOSTS: "1" });

      const features = irixServerFeatures();
      expect(features.schedulesDisabled).toBeUndefined();
      expect(features.connectedHosts).toBeUndefined();
      expect(features.hostMultiplexing).toBeUndefined();
    });

    // In-process: the daemon's default registry is built when the module loads, before any test
    // switches the policy on, so it cannot be inspected through the daemon in this harness.
    it("B6/B7 forges: with Irix active the registry knows only GitLab and github.com is not a forge", async () => {
      await startIrixDaemon();
      const upstream = [
        [
          "github",
          { createService: () => ({}) as never, matchesHost: (h: string) => h === "github.com" },
        ],
        ["gitea", { createService: () => ({}) as never }],
      ] as const;

      const registry = new ForgeRegistry(
        irixForgeEntries(
          [...upstream],
          createIrixGitLabAdapter(() => null),
        ),
      );

      expect(registry.ids()).toEqual(["gitlab"]);
      expect(registry.has("github")).toBe(false);
      expect(registry.matchHost("github.com")).toBeNull();
      expect(registry.create("github")).toBeNull();
    });
  },
);
