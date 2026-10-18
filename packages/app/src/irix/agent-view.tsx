import type { ComponentType } from "react";
import { IRIX_BUILD } from "./build";
import type { AgentViewProps } from "./agent-view-shell";

/**
 * Plugins get `ui.AgentView`: Paseo's own agent conversation (timeline, composer, pickers),
 * embedded outside a workspace tab. Only Irix builds export it, so a plugin tells the two
 * apart with `typeof ui.AgentView`.
 *
 * The shell is required on first render, not imported. The plugin runtime sits under the
 * plugin registry and the conversation screen imports that registry; a static import here
 * would close the loop.
 */
function LazyAgentView(props: AgentViewProps) {
  // oxlint-disable-next-line typescript-eslint/no-require-imports
  const { AgentViewShell } = require("./agent-view-shell") as typeof import("./agent-view-shell");
  return <AgentViewShell {...props} />;
}

export const AgentView: ComponentType<AgentViewProps> | undefined = IRIX_BUILD
  ? LazyAgentView
  : undefined;

/** Versioned features of the embedded view; bumped when the props change incompatibly. */
export const capabilities: { readonly agentView: 1 } | undefined = IRIX_BUILD
  ? { agentView: 1 }
  : undefined;
