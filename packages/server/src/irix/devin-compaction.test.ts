import { describe, expect, it, vi } from "vitest";

import type { AgentSession, AgentStreamEvent } from "../server/agent/agent-sdk-types.js";
import { attachDevinCompaction } from "./devin-client.js";
import { DevinCompaction } from "./devin-compaction.js";

// Notifications and updates as Devin sends them for `/compact` (captured from `devin acp`).
const METHOD = "_cognition.ai/compaction";
const STARTED = { status: "started", sessionId: "s1" };
const COMPLETED = { status: "completed", summary: "Summary:\n...", sessionId: "s1" };
const FAILED = { status: "failed", sessionId: "s1" };
const USAGE = {
  sessionId: "s1",
  update: { sessionUpdate: "usage_update", size: 200000, used: 19061 },
};
const NOTICE = {
  sessionId: "s1",
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Context compacted" },
  },
};
const TURN_USAGE = { inputTokens: 18924, outputTokens: 137 };

function translate(
  compaction: DevinCompaction,
  params: Record<string, unknown>,
  method = METHOD,
): AgentStreamEvent[] {
  return compaction.translate({
    method,
    params,
    provider: "devin",
    turnId: "turn-1",
    turnUsage: TURN_USAGE,
  });
}

describe("DevinCompaction", () => {
  it("opens the marker when Devin starts compacting, once", () => {
    const compaction = new DevinCompaction();

    expect(translate(compaction, STARTED)).toEqual([
      {
        type: "timeline",
        provider: "devin",
        turnId: "turn-1",
        item: { type: "compaction", status: "loading" },
      },
    ]);
    expect(translate(compaction, STARTED)).toEqual([]);
  });

  it("resolves the marker and clears the ring, keeping the window size and turn usage", () => {
    const compaction = new DevinCompaction();
    compaction.observeUpdate(USAGE);
    translate(compaction, STARTED);

    expect(translate(compaction, COMPLETED)).toEqual([
      {
        type: "timeline",
        provider: "devin",
        turnId: "turn-1",
        item: { type: "compaction", status: "completed" },
      },
      {
        type: "usage_updated",
        provider: "devin",
        turnId: "turn-1",
        usage: { ...TURN_USAGE, contextWindowMaxTokens: 200000 },
      },
    ]);
  });

  it("leaves the ring alone when no window size has been seen", () => {
    const compaction = new DevinCompaction();

    expect(translate(compaction, COMPLETED).map((event) => event.type)).toEqual(["timeline"]);
  });

  it("resolves the marker but keeps the ring when compaction fails", () => {
    const compaction = new DevinCompaction();
    compaction.observeUpdate(USAGE);
    translate(compaction, STARTED);

    expect(translate(compaction, FAILED).map((event) => event.type)).toEqual(["timeline"]);
  });

  it("opens a new marker for the next compaction", () => {
    const compaction = new DevinCompaction();
    translate(compaction, STARTED);
    translate(compaction, COMPLETED);

    expect(translate(compaction, STARTED)).toHaveLength(1);
  });

  it("accepts the method with or without its leading underscore, and ignores others", () => {
    const compaction = new DevinCompaction();

    expect(translate(compaction, STARTED, "cognition.ai/compaction")).toHaveLength(1);
    expect(translate(new DevinCompaction(), STARTED, "_cognition.ai/turn_stats")).toEqual([]);
  });

  it("drops the 'Context compacted' message after a completed compaction, once", () => {
    const compaction = new DevinCompaction();
    translate(compaction, COMPLETED);

    expect(compaction.isCompactedNotice(NOTICE, false)).toBe(true);
    expect(compaction.isCompactedNotice(NOTICE, false)).toBe(false);
  });

  it("keeps the same message when no compaction completed, when a turn is running, or after a failure", () => {
    const idle = new DevinCompaction();
    expect(idle.isCompactedNotice(NOTICE, false)).toBe(false);

    const running = new DevinCompaction();
    translate(running, COMPLETED);
    expect(running.isCompactedNotice(NOTICE, true)).toBe(false);

    const failed = new DevinCompaction();
    translate(failed, FAILED);
    expect(failed.isCompactedNotice(NOTICE, false)).toBe(false);
  });
});

describe("attachDevinCompaction", () => {
  function fakeSession(overrides: Record<string, unknown> = {}) {
    const handled: unknown[] = [];
    const pushed: AgentStreamEvent[] = [];
    const originalExt = vi.fn(async () => {});
    const session = {
      activeForegroundTurnId: null,
      currentTurnUsage: TURN_USAGE,
      sessionUpdate: vi.fn(async (params: unknown) => {
        handled.push(params);
      }),
      extNotification: originalExt,
      pushEvent: (event: AgentStreamEvent) => pushed.push(event),
      ...overrides,
    };
    attachDevinCompaction(session as unknown as AgentSession);
    return { session, handled, pushed, originalExt };
  }

  it("turns a /compact that ends the turn at once into a marker and a cleared ring", async () => {
    const { session, pushed } = fakeSession();

    await session.sessionUpdate(USAGE);
    await session.extNotification(METHOD, STARTED);
    await session.extNotification(METHOD, COMPLETED);

    expect(pushed.map((event) => event.type)).toEqual(["timeline", "timeline", "usage_updated"]);
    expect(pushed[2]).toMatchObject({
      usage: { ...TURN_USAGE, contextWindowMaxTokens: 200000 },
    });
    expect(pushed[2]).not.toHaveProperty("usage.contextWindowUsedTokens");
  });

  it("still gives every update and notification to the session first", async () => {
    const { session, handled, originalExt } = fakeSession();

    await session.sessionUpdate(USAGE);
    await session.extNotification(METHOD, STARTED);

    expect(handled).toEqual([USAGE]);
    expect(originalExt).toHaveBeenCalledTimes(1);
  });

  it("does not hand the 'Context compacted' message to the session", async () => {
    const { session, handled } = fakeSession();

    await session.extNotification(METHOD, COMPLETED);
    await session.sessionUpdate(NOTICE);

    expect(handled).toEqual([]);
  });

  it("shows nothing for the compaction in a history replay", async () => {
    const { session, pushed } = fakeSession({ replayingHistory: true });

    await session.extNotification(METHOD, STARTED);
    await session.extNotification(METHOD, COMPLETED);

    expect(pushed).toEqual([]);
  });
});
