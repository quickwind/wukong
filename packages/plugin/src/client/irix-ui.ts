import type { ComponentType } from "react";

// Irix only. Other builds leave these undefined: check `typeof AgentView !== "undefined"`.
export interface AgentViewProps {
  agentId: string;
  serverId: string;
  workspaceId: string;
  /** Called when a file path in the conversation is opened. Without it, file links do nothing. */
  onOpenWorkspaceFile?(request: {
    location: { path: string; lineStart?: number; lineEnd?: number };
    disposition: "main" | "preferred" | "side";
  }): void;
}

/**
 * Paseo's own agent conversation: timeline, composer, model, mode and thinking pickers,
 * permission prompts, and every plugin's timeline renderers and composer pills. It fills the
 * space its parent gives it and scrolls inside; give the parent `flex: 1` and `minHeight: 0`.
 */
export declare const AgentView: ComponentType<AgentViewProps> | undefined;

/** Versioned features of `AgentView`. `agentView: 1` is the `AgentViewProps` above. */
export declare const capabilities: { readonly agentView: 1 } | undefined;
