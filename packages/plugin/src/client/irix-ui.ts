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

/**
 * What this Irix host offers. `agentView: 1` is the `AgentViewProps` above. `managedProjectsHidden: 1`
 * means the sidebar and New workspace leave out the project a plugin manages (for Bot Crew, the
 * `Bots` project under `plugin-data/bot-crew`), so a plugin that draws its own tree of it will not
 * be duplicated by the native one. Absent on hosts that still list it.
 */
export declare const capabilities:
  | { readonly agentView: 1; readonly managedProjectsHidden?: 1 }
  | undefined;
