import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installCallerRouting } from "./caller-routing.js";
import {
  clearPendingRun,
  fingerprintRun,
  PENDING_RUN_TTL_MS,
  pendingRunKey,
} from "./pending-run.js";

describe("pending run keys", () => {
  const home = mkdtempSync(path.join(tmpdir(), "irix-pending-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("names a request by its caller and content, not by request id or key", () => {
    const base = { prompt: "work", provider: "claude", cwd: "/repo" };
    expect(fingerprintRun("a1", { ...base, requestId: "r1" })).toBe(
      fingerprintRun("a1", {
        cwd: "/repo",
        provider: "claude",
        prompt: "work",
        idempotencyKey: "k",
      }),
    );
    expect(fingerprintRun("a1", base)).not.toBe(fingerprintRun("a2", base));
    expect(fingerprintRun("a1", base)).not.toBe(fingerprintRun("a1", { ...base, prompt: "other" }));
  });

  it("reuses the key of an unfinished attempt for ten minutes, and forgets it once cleared", () => {
    const now = 1_000_000;
    const first = pendingRunKey(home, "fp1", now);
    expect(first.resumed).toBe(false);
    expect(pendingRunKey(home, "fp1", now + 60_000)).toEqual({ key: first.key, resumed: true });
    expect(pendingRunKey(home, "fp1", now + PENDING_RUN_TTL_MS + 1).resumed).toBe(false);

    const second = pendingRunKey(home, "fp2", now);
    clearPendingRun(home, "fp2");
    expect(pendingRunKey(home, "fp2", now).key).not.toBe(second.key);
  });
});

interface CreateOptions {
  callerAgentId?: string;
  idempotencyKey?: string;
  initialPrompt?: string;
}

type CreateFn = (this: unknown, options: CreateOptions) => Promise<unknown>;

describe("agent run window", () => {
  const home = mkdtempSync(path.join(tmpdir(), "irix-window-"));
  const env: NodeJS.ProcessEnv = { PASEO_HOME: home, IRIX_APPROVAL_WINDOW_MS: "50" };
  const prototype = DaemonClient.prototype as unknown as { createAgent: CreateFn };
  const calls: CreateOptions[] = [];
  let release: (value: unknown) => void = () => {};
  let fail: (error: Error) => void = () => {};

  beforeAll(() => {
    prototype.createAgent = (options) => {
      calls.push(options);
      return new Promise((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
    };
    installCallerRouting(env);
  });
  beforeEach(() => {
    calls.length = 0;
    env.PASEO_AGENT_ID = "agent-1";
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const client = (required: boolean) => ({
    lastServerInfoMessage: { features: { requireSubagentApproval: required } },
  });
  const run = (required = true, options: CreateOptions = {}) =>
    prototype.createAgent.call(client(required), {
      callerAgentId: "agent-1",
      initialPrompt: "work",
      ...options,
    });

  it("exits with a pending message after the window, and the same command resumes the same key", async () => {
    await expect(run()).rejects.toMatchObject({ code: "SUBAGENT_APPROVAL_PENDING" });
    await expect(run()).rejects.toMatchObject({ code: "SUBAGENT_APPROVAL_PENDING" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.idempotencyKey).toMatch(/^irix-run-/);
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);

    const done = run();
    release({ id: "child" });
    await expect(done).resolves.toEqual({ id: "child" });
    expect(calls[2]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);

    // The outcome ended that request: a later identical run is a new one.
    await expect(run()).rejects.toMatchObject({ code: "SUBAGENT_APPROVAL_PENDING" });
    expect(calls[3]!.idempotencyKey).not.toBe(calls[0]!.idempotencyKey);
  });

  it("passes a refusal through and forgets the request", async () => {
    const refused = run(true, { initialPrompt: "refused" });
    fail(new Error("Subagent creation was rejected by user"));
    await expect(refused).rejects.toThrow(/rejected by user/);
    await expect(run(true, { initialPrompt: "refused" })).rejects.toMatchObject({
      code: "SUBAGENT_APPROVAL_PENDING",
    });
    expect(calls[1]!.idempotencyKey).not.toBe(calls[0]!.idempotencyKey);
  });

  it("changes nothing when approval is off, outside an agent's shell, or without a caller", async () => {
    const results: unknown[] = [];
    for (const step of [
      () => run(false),
      () => {
        delete env.PASEO_AGENT_ID;
        return run(true);
      },
      () => {
        env.PASEO_AGENT_ID = "agent-1";
        return run(true, { callerAgentId: undefined });
      },
    ]) {
      const pending = step();
      release("ok");
      results.push(await pending);
    }
    expect(results).toEqual(["ok", "ok", "ok"]);
    expect(calls.map((call) => call.idempotencyKey)).toEqual([undefined, undefined, undefined]);
  });
});
