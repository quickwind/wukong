// Irix edition: shows Devin's own subagents as a subagent card.
//
// Devin runs `run_subagent` inside the parent's ACP stream, with no session of its own. Besides the
// `run_subagent` tool call, the stream has an entry whose tool call id is the subagent's id, updated
// with `cognition.ai/subagent_started` and `cognition.ai/subagent_completed` markers, and the
// subagent's own tool calls as ordinary ones tagged `cognition.ai/subagent_context`
// (`parentAgentId` = the subagent's id). Upstream's ACP mapper drops that metadata, so the entry
// shows as an empty placeholder named after the id. This fills it, under the same call id, with the `sub_agent` detail the app already knows how to render: the task, what
// the subagent ran, and its final answer.

import type {
  AgentStreamEvent,
  ToolCallDetail,
  ToolCallTimelineItem,
} from "../server/agent/agent-sdk-types.js";

type StreamEvent = Extract<AgentStreamEvent, { type: "timeline" }>;

interface SubagentCard {
  agentId: string;
  title: string;
  profile?: string;
  task?: string;
  lines: string[];
  status: "running" | "completed" | "failed";
  summary?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function toDetail(card: SubagentCard): ToolCallDetail {
  const log = [...card.lines, ...(card.summary ? ["", card.summary] : [])].join("\n");
  return {
    type: "sub_agent",
    ...(card.profile ? { subAgentType: card.profile } : {}),
    ...(card.task ? { description: card.task } : {}),
    ...(card.agentId ? { childSessionId: card.agentId } : {}),
    log,
  };
}

/** Follows one Devin session's updates. `observe` returns the card to show after an update, if it changed. */
export class DevinSubagentCards {
  private readonly cards = new Map<string, SubagentCard>();

  observe(params: Record<string, unknown>, provider: string, turnId?: string): StreamEvent | null {
    const update = asRecord(params.update);
    if (!update) {
      return null;
    }
    const card = this.update(update, asRecord(update._meta));
    if (!card) {
      return null;
    }
    const base = {
      type: "tool_call" as const,
      callId: card.agentId,
      name: card.title,
      detail: toDetail(card),
      metadata: { title: card.title },
    };
    const item: ToolCallTimelineItem =
      card.status === "failed"
        ? { ...base, status: "failed", error: { message: card.summary ?? "Subagent failed" } }
        : { ...base, status: card.status, error: null };
    return { type: "timeline", provider, item, turnId };
  }

  private update(
    update: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
  ): SubagentCard | null {
    const started = asRecord(meta?.["cognition.ai/subagent_started"]);
    const startedId = asString(started?.agentId);
    if (started && startedId) {
      const card: SubagentCard = {
        agentId: startedId,
        title: asString(started.title) ?? "Subagent",
        profile: asString(started.profile),
        task: asString(started.task),
        lines: [],
        status: "running",
      };
      this.cards.set(startedId, card);
      return card;
    }
    const completed = asRecord(meta?.["cognition.ai/subagent_completed"]);
    const completedId = asString(completed?.agentId);
    const done = completedId ? this.cards.get(completedId) : undefined;
    if (completed && done) {
      done.status = completed.success === false ? "failed" : "completed";
      done.summary = asString(completed.summary) ?? done.summary;
      return done;
    }
    return this.recordChildToolCall(update, meta);
  }

  /** A tool call the subagent itself made: one `[Tool] what` line on its card. */
  private recordChildToolCall(
    update: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
  ): SubagentCard | null {
    if (update.sessionUpdate !== "tool_call") {
      return null;
    }
    const parentId = asString(asRecord(meta?.["cognition.ai/subagent_context"])?.parentAgentId);
    const card = parentId ? this.cards.get(parentId) : undefined;
    const title = asString(update.title);
    if (!card || !title) {
      return null;
    }
    const rawInput = asRecord(update.rawInput);
    const what = asString(rawInput?.command) ?? asString(rawInput?.cmd) ?? title;
    card.lines.push(`[${asString(update.kind) ?? "tool"}] ${oneLine(what)}`);
    return card;
  }
}
