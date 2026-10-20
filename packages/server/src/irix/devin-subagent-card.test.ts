import { describe, expect, it } from "vitest";

import { DevinSubagentCards } from "./devin-subagent-card.js";

// Updates as Devin sends them for one `run_subagent` call (captured from `devin acp`).
const STARTED = {
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "ebb3832f",
    status: "in_progress",
    _meta: {
      "cognition.ai/subagent_started": {
        agentId: "ebb3832f",
        title: "Run sleep command",
        task: "Run `sleep 2 && echo hi` and return the output.",
        profile: "General",
      },
    },
  },
};
const CHILD_TOOL = {
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "call_41",
    title: "Ran sleep, echo",
    kind: "execute",
    rawInput: { command: "sleep 2 && echo hi" },
    _meta: { "cognition.ai/subagent_context": { parentAgentId: "ebb3832f" } },
  },
};
const COMPLETED = {
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "ebb3832f",
    status: "completed",
    _meta: {
      "cognition.ai/subagent_completed": {
        agentId: "ebb3832f",
        success: true,
        summary: "Output: `hi`",
      },
    },
  },
};

describe("Devin subagent cards", () => {
  it("fills the subagent's entry with its task, commands and answer", () => {
    const cards = new DevinSubagentCards();

    const started = cards.observe(STARTED, "devin", "turn-1");
    expect(started).toMatchObject({
      type: "timeline",
      turnId: "turn-1",
      item: {
        callId: "ebb3832f",
        status: "running",
        detail: { type: "sub_agent", subAgentType: "General", childSessionId: "ebb3832f" },
      },
    });

    const ran = cards.observe(CHILD_TOOL, "devin");
    expect(ran?.item).toMatchObject({
      detail: { log: "[execute] sleep 2 && echo hi" },
    });

    const done = cards.observe(COMPLETED, "devin");
    expect(done?.item).toMatchObject({
      callId: "ebb3832f",
      status: "completed",
      detail: { log: "[execute] sleep 2 && echo hi\n\nOutput: `hi`" },
    });
  });

  it("marks a failed subagent as failed", () => {
    const cards = new DevinSubagentCards();
    cards.observe(STARTED, "devin");
    const failed = cards.observe(
      {
        update: {
          ...COMPLETED.update,
          _meta: {
            "cognition.ai/subagent_completed": {
              agentId: "ebb3832f",
              success: false,
              summary: "boom",
            },
          },
        },
      },
      "devin",
    );
    expect(failed?.item).toMatchObject({ status: "failed", error: { message: "boom" } });
  });

  it("ignores everything else", () => {
    const cards = new DevinSubagentCards();
    expect(cards.observe(CHILD_TOOL, "devin")).toBeNull();
    expect(
      cards.observe(
        { update: { sessionUpdate: "tool_call", toolCallId: "x", title: "Ran ls" } },
        "devin",
      ),
    ).toBeNull();
    expect(cards.observe({}, "devin")).toBeNull();
  });
});
