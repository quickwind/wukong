// Irix edition: shows Devin's compaction as the compaction marker, and clears the context ring.
//
// Devin runs `/compact` as a slash command: the prompt ends at once, with no update, and the work
// is reported afterwards in `_cognition.ai/compaction` notifications (`started`, then `completed`
// or `failed`, about five seconds apart). Upstream's ACP session ignores those, so the composer
// showed nothing while Devin compacted. Devin reports no usage when it is done (`/context` answers
// "No context usage available yet" until the next message), so the ring would keep the old, now
// wrong, number until the next turn. After `completed` the ring is cleared instead: the window
// size stays, the used count goes, and the next turn's `usage_update` fills it in again.
//
// A `failed` compaction leaves the context as it was, so the ring is kept. The marker has no
// failed state, so it is resolved like a completed one.
//
// Devin also sends the text "Context compacted" as an assistant message after `completed`, outside
// any turn. The marker says the same, so that one message is dropped.

import type { AgentStreamEvent, AgentUsage } from "../server/agent/agent-sdk-types.js";

const COMPACTION_METHOD = "cognition.ai/compaction";
const COMPACTED_NOTICE = "Context compacted";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface TranslateInput {
  method: string;
  params: Record<string, unknown>;
  provider: string;
  turnId?: string;
  turnUsage?: AgentUsage;
}

export class DevinCompaction {
  private windowSize: number | undefined;
  private markerOpen = false;
  private noticePending = false;

  /** Remembers the window size from each `usage_update`, to keep it when the ring is cleared. */
  observeUpdate(params: Record<string, unknown>): void {
    const update = asRecord(params.update);
    if (update?.sessionUpdate !== "usage_update") {
      return;
    }
    const size = update.size;
    if (typeof size === "number" && Number.isFinite(size) && size > 0) {
      this.windowSize = size;
    }
  }

  /**
   * True for the one "Context compacted" message Devin sends after a completed compaction, when
   * no turn is running. Any other message ends the wait for it.
   */
  isCompactedNotice(params: Record<string, unknown>, turnRunning: boolean): boolean {
    const update = asRecord(params.update);
    if (update?.sessionUpdate !== "agent_message_chunk") {
      return false;
    }
    const pending = this.noticePending;
    this.noticePending = false;
    const text = asRecord(update.content)?.text;
    return pending && !turnRunning && text === COMPACTED_NOTICE;
  }

  translate(input: TranslateInput): AgentStreamEvent[] {
    if (input.method.replace(/^_/, "") !== COMPACTION_METHOD) {
      return [];
    }
    const { provider, turnId } = input;
    switch (input.params.status) {
      case "started": {
        if (this.markerOpen) {
          return [];
        }
        this.markerOpen = true;
        return [
          { type: "timeline", provider, turnId, item: { type: "compaction", status: "loading" } },
        ];
      }
      case "completed":
      case "failed": {
        const completed = input.params.status === "completed";
        this.markerOpen = false;
        this.noticePending = completed;
        const events: AgentStreamEvent[] = [
          { type: "timeline", provider, turnId, item: { type: "compaction", status: "completed" } },
        ];
        if (completed && this.windowSize !== undefined) {
          events.push({
            type: "usage_updated",
            provider,
            turnId,
            usage: { ...input.turnUsage, contextWindowMaxTokens: this.windowSize },
          });
        }
        return events;
      }
      default:
        return [];
    }
  }
}
