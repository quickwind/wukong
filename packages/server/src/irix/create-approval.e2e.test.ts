// Daemon-level proof of the approval for an agent started by an agent over the WebSocket API:
// the card goes to the caller, nothing is created before the answer, and one request is one card.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getFullAccessConfig } from "../server/daemon-e2e/agent-configs.js";
import {
  createDaemonTestContext,
  DaemonClient,
  type DaemonTestContext,
} from "../server/test-utils/index.js";
import { activateIrixPolicy } from "./policy.js";
import { resetSubagentApprovalCacheForTests } from "./subagent-approval.js";

let ctx: DaemonTestContext;
let deactivate: () => void;
const tempRoots: string[] = [];

beforeEach(async () => {
  // The caller runs in a bypass mode, which Irix hides unless this is set.
  vi.stubEnv("IRIX_ALLOW_BYPASS_MODES", "1");
  // Some tests turn the approval setting off, which Irix allows only with this.
  vi.stubEnv("IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL", "1");
  // The daemon is built first: with the policy on, the provider registry loses the fake provider.
  ctx = await createDaemonTestContext();
  deactivate = activateIrixPolicy();
  resetSubagentApprovalCacheForTests(true);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await ctx.cleanup();
  deactivate();
  resetSubagentApprovalCacheForTests(null);
  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Windows keeps a worktree directory locked while the daemon's watcher closes; it is a temp dir.
    }
  }
});

function createGitRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "irix-create-approval-"));
  tempRoots.push(root);
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@getpaseo.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Irix Test"], { cwd: repo });
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], { cwd: repo });
  return repo;
}

async function startCaller(repo: string): Promise<string> {
  const caller = await ctx.client.createAgent({
    config: { ...getFullAccessConfig("codex"), cwd: repo },
    initialPrompt: "Say done.",
  });
  await ctx.client.waitForFinish(caller.id, 10000);
  return caller.id;
}

async function waitForCard(callerId: string): Promise<{ id: string; name: string }> {
  let card: { id: string; name: string } | undefined;
  await expect
    .poll(
      async () => {
        const state = await ctx.client.fetchAgent(callerId);
        card = state?.agent.pendingPermissions[0];
        return card?.name;
      },
      { timeout: 10000, interval: 50 },
    )
    .toBe("SpawnSubagent");
  return card as { id: string; name: string };
}

async function agentCount(): Promise<number> {
  return (await ctx.client.fetchAgents()).entries.length;
}

// Each test starts a daemon and provisions a git worktree; Windows under load needs more than 30 s.
describe("agent-started agent creation", { timeout: 90_000 }, () => {
  test("waits for the caller's approval before provisioning the worktree, then creates it", async () => {
    const repo = createGitRepo();
    const callerId = await startCaller(repo);
    const before = await agentCount();

    const creation = ctx.client.createAgent({
      config: { ...getFullAccessConfig("codex"), cwd: repo },
      callerAgentId: callerId,
      worktree: { mode: "branch-off", newBranch: "approved-child", base: "main" },
      initialPrompt: "Say done.",
    });
    const card = await waitForCard(callerId);

    expect((await ctx.client.getPaseoWorktreeList({ cwd: repo })).worktrees).toEqual([]);
    expect(await agentCount()).toBe(before);

    await ctx.client.respondToPermission(callerId, card.id, { behavior: "allow" });
    const child = await creation;

    expect(child.cwd).not.toBe(repo);
    expect(existsSync(child.cwd)).toBe(true);
    expect((await ctx.client.fetchAgent(callerId))?.agent.pendingPermissions).toEqual([]);
  });

  test("creates nothing and no worktree when the caller denies", async () => {
    const repo = createGitRepo();
    const callerId = await startCaller(repo);
    const before = await agentCount();

    const creation = ctx.client.createAgent({
      config: { ...getFullAccessConfig("codex"), cwd: repo },
      callerAgentId: callerId,
      worktree: { mode: "branch-off", newBranch: "denied-child", base: "main" },
      initialPrompt: "Say done.",
    });
    const rejection = expect(creation).rejects.toThrow(/rejected by user/);
    const card = await waitForCard(callerId);
    await ctx.client.respondToPermission(callerId, card.id, { behavior: "deny", message: "no" });
    await rejection;

    expect((await ctx.client.getPaseoWorktreeList({ cwd: repo })).worktrees).toEqual([]);
    expect(await agentCount()).toBe(before);
  });

  test("denies and cleans up the card when the caller is closed while waiting", async () => {
    const repo = createGitRepo();
    const callerId = await startCaller(repo);

    const creation = ctx.client.createAgent({
      config: { ...getFullAccessConfig("codex"), cwd: repo },
      callerAgentId: callerId,
      initialPrompt: "Say done.",
    });
    const rejection = expect(creation).rejects.toThrow(/rejected by user/);
    await waitForCard(callerId);
    await ctx.client.deleteAgent(callerId);
    await rejection;
  });

  test("asks nobody when the approval setting is off", async () => {
    resetSubagentApprovalCacheForTests(false);
    const repo = createGitRepo();
    const callerId = await startCaller(repo);

    const child = await ctx.client.createAgent({
      config: { ...getFullAccessConfig("codex"), cwd: repo },
      callerAgentId: callerId,
      initialPrompt: "Say done.",
    });

    expect(child.id).not.toBe(callerId);
  });

  test("a workspace created with an agent raises one card, before the workspace exists", async () => {
    const repo = createGitRepo();
    const callerId = await startCaller(repo);

    const creation = ctx.client.createWorkspace({
      source: {
        kind: "worktree",
        cwd: repo,
        action: "branch-off",
        baseBranch: "main",
        branchName: "ws-child",
      },
      callerAgentId: callerId,
      agent: { config: { ...getFullAccessConfig("codex"), cwd: repo }, initialPrompt: "Say done." },
    });
    const card = await waitForCard(callerId);
    expect((await ctx.client.getPaseoWorktreeList({ cwd: repo })).worktrees).toEqual([]);

    await ctx.client.respondToPermission(callerId, card.id, { behavior: "allow" });
    const result = await creation;

    expect(result.error).toBeFalsy();
    expect(result.workspace).toBeTruthy();
    expect((await ctx.client.fetchAgent(callerId))?.agent.pendingPermissions).toEqual([]);
  });

  test("loads an idle-released caller to show the card instead of failing", async () => {
    const repo = createGitRepo();
    const callerId = await startCaller(repo);
    await ctx.daemon.daemon.agentManager.closeAgent(callerId);
    expect(ctx.daemon.daemon.agentManager.getAgent(callerId)).toBeNull();

    const creation = ctx.client.createAgent({
      config: { ...getFullAccessConfig("codex"), cwd: repo },
      callerAgentId: callerId,
      initialPrompt: "Say done.",
    });
    const card = await waitForCard(callerId);
    await ctx.client.respondToPermission(callerId, card.id, { behavior: "allow" });

    expect((await creation).id).not.toBe(callerId);
  });

  test("a resent workspace request with the same key raises no second card", async () => {
    const repo = createGitRepo();
    const callerId = await startCaller(repo);
    const request = {
      source: {
        kind: "worktree" as const,
        cwd: repo,
        action: "branch-off" as const,
        baseBranch: "main",
        branchName: "resent",
      },
      callerAgentId: callerId,
      idempotencyKey: "resent-workspace",
      agent: { config: { ...getFullAccessConfig("codex"), cwd: repo }, initialPrompt: "Say done." },
    };

    const first = ctx.client.createWorkspace(request);
    const card = await waitForCard(callerId);
    await ctx.client.respondToPermission(callerId, card.id, { behavior: "allow" });
    const created = await first;

    const resent = await ctx.client.createWorkspace(request);

    expect(resent.workspace?.id).toBe(created.workspace?.id);
    expect((await ctx.client.fetchAgent(callerId))?.agent.pendingPermissions).toEqual([]);
  });

  test("a keyed request outlives its connection: approval creates the agent once, and the same key attaches", async () => {
    const repo = createGitRepo();
    const callerId = await startCaller(repo);
    const before = await agentCount();
    const request = {
      config: { ...getFullAccessConfig("codex"), cwd: repo },
      callerAgentId: callerId,
      initialPrompt: "Say done.",
      idempotencyKey: "irix-run-resume-test",
    };

    // The first `irix run` gives up after its window and exits.
    const cli = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
    await cli.connect();
    const abandoned = cli.createAgent(request).catch((error: Error) => error);
    const card = await waitForCard(callerId);
    await cli.close();
    await abandoned;

    // The card stays, and the same command run again attaches to it instead of asking again.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await ctx.client.fetchAgent(callerId))?.agent.pendingPermissions).toHaveLength(1);
    const rerun = ctx.client.createAgent(request);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect((await ctx.client.fetchAgent(callerId))?.agent.pendingPermissions).toHaveLength(1);
    expect(await agentCount()).toBe(before);

    await ctx.client.respondToPermission(callerId, card.id, { behavior: "allow" });
    const child = await rerun;

    expect(child.id).not.toBe(callerId);
    expect(await agentCount()).toBe(before + 1);
    expect((await ctx.client.fetchAgent(callerId))?.agent.pendingPermissions).toEqual([]);
  });
});
