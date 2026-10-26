import type { ContextLevel } from "../shared/level.js";

const RANK: Record<ContextLevel, number> = { none: 0, warn: 1, critical: 2 };

/** "Don't remind me" per agent: hides a level until the context gets worse or is freed. */
export class Dismissals {
  private readonly dismissed = new Map<string, ContextLevel>();

  dismiss(agentId: string, level: ContextLevel): void {
    this.dismissed.set(agentId, level);
  }

  forget(agentId: string): void {
    this.dismissed.delete(agentId);
  }

  visibleLevel(agentId: string, level: ContextLevel): ContextLevel {
    if (level === "none") {
      this.dismissed.delete(agentId);
      return "none";
    }
    const dismissed = this.dismissed.get(agentId);
    return dismissed !== undefined && RANK[level] <= RANK[dismissed] ? "none" : level;
  }
}
