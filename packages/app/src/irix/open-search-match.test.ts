import { describe, expect, it, vi } from "vitest";

import { FOCUSED_PANE_PLACEMENT } from "@/stores/workspace-layout-store";
import type { Match } from "./content-search";
import { openSearchMatch } from "./open-search-match";

const match: Match = {
  path: "src/app.ts",
  line: 42,
  column: 7,
  text: "const foo = 1;",
  ranges: [{ start: 6, end: 9 }],
};

describe("openSearchMatch", () => {
  it("opens the file at the match line, then reveals the tab", () => {
    const openWorkspaceTabInFocusedPane = vi.fn(() => "tab-1");
    const revealWorkspaceTab = vi.fn();

    openSearchMatch({
      match,
      persistenceKey: "server:workspace",
      openWorkspaceTabInFocusedPane,
      revealWorkspaceTab,
    });

    expect(openWorkspaceTabInFocusedPane).toHaveBeenCalledWith(
      "server:workspace",
      { kind: "file", path: "src/app.ts", lineStart: 42 },
      FOCUSED_PANE_PLACEMENT,
    );
    expect(revealWorkspaceTab).toHaveBeenCalledWith("server:workspace", "tab-1");
  });

  it("does nothing without a persistence key", () => {
    const openWorkspaceTabInFocusedPane = vi.fn(() => "tab-1");
    const revealWorkspaceTab = vi.fn();

    openSearchMatch({
      match,
      persistenceKey: null,
      openWorkspaceTabInFocusedPane,
      revealWorkspaceTab,
    });

    expect(openWorkspaceTabInFocusedPane).not.toHaveBeenCalled();
    expect(revealWorkspaceTab).not.toHaveBeenCalled();
  });

  it("does not reveal when no tab opened", () => {
    const revealWorkspaceTab = vi.fn();

    openSearchMatch({
      match,
      persistenceKey: "server:workspace",
      openWorkspaceTabInFocusedPane: () => null,
      revealWorkspaceTab,
    });

    expect(revealWorkspaceTab).not.toHaveBeenCalled();
  });
});
