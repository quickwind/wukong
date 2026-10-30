// Daemon-level proof of the approval for schedule operations that can start a new agent.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getFullAccessConfig } from "../server/daemon-e2e/agent-configs.js";
import { createDaemonTestContext, type DaemonTestContext } from "../server/test-utils/index.js";
import { activateIrixPolicy } from "./policy.js";
import { resetSubagentApprovalCacheForTests } from "./subagent-approval.js";

let ctx: DaemonTestContext;
let deactivate: () => void;
let cwd: string;
let callerId: string;

// The request helper the CLI patch wraps; the public methods cannot name a caller.
async function send(
  message: Record<string, unknown>,
  responseType: string,
): Promise<{ error: string | null; schedule?: unknown }> {
  const client = ctx.client as unknown as {
    sendCorrelatedSessionRequest(
      params: unknown,
    ): Promise<{ error: string | null; schedule?: unknown }>;
  };
  // A daemon refusal arrives as an RPC error; report it as `error` like a payload error. The
  // schedule store renames a temp file, which Windows sometimes refuses for a moment (EPERM).
  let outcome: { error: string | null; schedule?: unknown } = { error: null };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    outcome = await client
      .sendCorrelatedSessionRequest({ message, responseType })
      .catch((error: Error) => ({ error: error.message }));
    if (!outcome.error?.includes("EPERM")) {
      break;
    }
  }
  return outcome;
}

const newAgentTarget = () => ({
  type: "new-agent",
  config: { provider: "codex", cwd, isolation: "local" },
});
const cadence = { type: "cron", expression: "0 9 * * *" };

async function createSchedule(withCaller: boolean, prompt = "check things") {
  return send(
    {
      type: "schedule/create",
      prompt,
      cadence,
      target: newAgentTarget(),
      ...(withCaller ? { callerAgentId: callerId } : {}),
    },
    "schedule/create/response",
  );
}

async function waitForCard(): Promise<{ id: string }> {
  let card: { id: string } | undefined;
  await expect
    .poll(
      async () => {
        card = (await ctx.client.fetchAgent(callerId))?.agent.pendingPermissions[0];
        return card?.id !== undefined;
      },
      { timeout: 10000, interval: 50 },
    )
    .toBe(true);
  return card as { id: string };
}

async function cardCount(): Promise<number> {
  return (await ctx.client.fetchAgent(callerId))?.agent.pendingPermissions.length ?? 0;
}

beforeEach(async () => {
  vi.stubEnv("IRIX_ALLOW_SCHEDULES", "1");
  // The caller runs in a bypass mode, which Irix hides unless this is set.
  vi.stubEnv("IRIX_ALLOW_BYPASS_MODES", "1");
  // Some tests turn the approval setting off, which Irix allows only with this.
  vi.stubEnv("IRIX_ALLOW_SUBAGENT_APPROVAL_CONTROL", "1");
  ctx = await createDaemonTestContext();
  deactivate = activateIrixPolicy();
  resetSubagentApprovalCacheForTests(true);
  cwd = mkdtempSync(path.join(tmpdir(), "irix-schedule-approval-"));
  const caller = await ctx.client.createAgent({
    config: { ...getFullAccessConfig("codex"), cwd },
    initialPrompt: "Say done.",
  });
  await ctx.client.waitForFinish(caller.id, 10000);
  callerId = caller.id;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await ctx.cleanup();
  deactivate();
  resetSubagentApprovalCacheForTests(null);
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Windows holds the directory while the daemon's watcher closes; it is a temp dir.
  }
});

describe("schedule approval", () => {
  test("a new-agent schedule from an agent waits for approval, and exists only after it", async () => {
    const creation = createSchedule(true);
    const card = await waitForCard();
    expect((await ctx.client.scheduleList()).schedules).toEqual([]);

    await ctx.client.respondToPermission(callerId, card.id, { behavior: "allow" });

    expect((await creation).error).toBeNull();
    expect((await ctx.client.scheduleList()).schedules).toHaveLength(1);
  });

  test("denial creates no schedule", async () => {
    const creation = createSchedule(true);
    const card = await waitForCard();
    await ctx.client.respondToPermission(callerId, card.id, { behavior: "deny", message: "no" });

    expect((await creation).error).toMatch(/rejected by user/);
    expect((await ctx.client.scheduleList()).schedules).toEqual([]);
  });

  test("a schedule with no calling agent is not asked", async () => {
    expect((await createSchedule(false)).error).toBeNull();
    expect(await cardCount()).toBe(0);
  });

  test("run-once and resume of a new-agent schedule ask, and run-once denial runs nothing", async () => {
    const created = (await createSchedule(false)) as { schedule: { id: string } };
    const id = created.schedule.id;

    const run = send(
      { type: "schedule/run-once", scheduleId: id, callerAgentId: callerId },
      "schedule/run-once/response",
    );
    const card = await waitForCard();
    await ctx.client.respondToPermission(callerId, card.id, { behavior: "deny", message: "no" });
    expect((await run).error).toMatch(/rejected by user/);
    expect((await ctx.client.scheduleInspect({ id })).schedule?.runs).toEqual([]);

    await ctx.client.schedulePause({ id });
    const resume = send(
      { type: "schedule/resume", scheduleId: id, callerAgentId: callerId },
      "schedule/resume/response",
    );
    const resumeCard = await waitForCard();
    await ctx.client.respondToPermission(callerId, resumeCard.id, {
      behavior: "deny",
      message: "no",
    });
    expect((await resume).error).toMatch(/rejected by user/);
    expect((await ctx.client.scheduleInspect({ id })).schedule?.status).toBe("paused");
  });

  test("a name-only update is not asked; a prompt update is", async () => {
    const created = (await createSchedule(false)) as { schedule: { id: string } };
    const id = created.schedule.id;

    const rename = await send(
      { type: "schedule/update", scheduleId: id, name: "renamed", callerAgentId: callerId },
      "schedule/update/response",
    );
    expect(rename.error).toBeNull();
    expect(await cardCount()).toBe(0);

    const edit = send(
      {
        type: "schedule/update",
        scheduleId: id,
        prompt: "do something else",
        callerAgentId: callerId,
      },
      "schedule/update/response",
    );
    const card = await waitForCard();
    await ctx.client.respondToPermission(callerId, card.id, { behavior: "allow" });
    expect((await edit).error).toBeNull();
  });

  test("asks nobody when the approval setting is off", async () => {
    resetSubagentApprovalCacheForTests(false);
    expect((await createSchedule(true)).error).toBeNull();
    expect(await cardCount()).toBe(0);
  });
});
