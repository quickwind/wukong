import {
  FOCUSED_PANE_PLACEMENT,
  type WorkspaceTabPlacement,
} from "@/stores/workspace-layout-store";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
} from "@/workspace/file-open";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { Match } from "./content-search";

interface OpenSearchMatchInput {
  match: Match;
  persistenceKey: string | null;
  openWorkspaceTabInFocusedPane: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    placement?: WorkspaceTabPlacement,
  ) => string | null;
  revealWorkspaceTab: (workspaceKey: string, tabId: string) => void;
}

/** Opens a search match where the Files tree opens a file, scrolled to the match line. */
export function openSearchMatch(input: OpenSearchMatchInput): void {
  if (!input.persistenceKey) return;
  const location = normalizeWorkspaceFileLocation({
    path: input.match.path,
    lineStart: input.match.line,
  });
  if (!location) return;
  const tabId = input.openWorkspaceTabInFocusedPane(
    input.persistenceKey,
    createWorkspaceFileTabTarget(location),
    FOCUSED_PANE_PLACEMENT,
  );
  if (tabId) input.revealWorkspaceTab(input.persistenceKey, tabId);
}
