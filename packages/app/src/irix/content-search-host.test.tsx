/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Match } from "./content-search";

// The real Files pane, rendered with an Irix build switched on and off. Its data hooks are stubbed
// so the tree shows one file; the search panel is a stub that records the props it was given.
const fake = vi.hoisted(() => ({
  client: { id: "client" } as unknown,
  panelProps: [] as Array<{
    serverId: string;
    workspaceId: string | null;
    cwd: string;
    onOpenMatch: (match: Match) => void;
  }>,
  openTab: vi.fn((_input: unknown) => "tab-1"),
  revealWorkspaceTab: vi.fn(),
}));

const explorerState = {
  directories: new Map([
    [
      ".",
      {
        path: ".",
        entries: [
          { name: "app.ts", path: "app.ts", kind: "file", size: 1, modifiedAt: "2026-01-01" },
        ],
      },
    ],
  ]),
  isLoading: false,
  lastError: null,
  pendingRequest: null,
  currentPath: ".",
  history: [],
  lastVisitedPath: ".",
  selectedEntryPath: null,
};

vi.mock("react-native-unistyles", async () => {
  const { darkTheme: theme } = await import("@/styles/theme");
  return {
    StyleSheet: {
      create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
    },
    withUnistyles: <T,>(component: T) => component,
    useUnistyles: () => ({ theme, rt: { breakpoint: "md" } }),
  };
});

// The shared lucide stub lacks some of the toolbar's and the file menu's icons.
vi.mock("lucide-react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react-native")>();
  const icon = () => null;
  return {
    ...actual,
    ArrowRightToLine: icon,
    CopyPlus: icon,
    EyeOff: icon,
    FilePlus: icon,
    FolderMinus: icon,
    FolderOpen: icon,
    FolderPlus: icon,
    Search: icon,
  };
});

vi.mock("@/stores/session-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/session-store")>();
  const state = {
    sessions: {
      server: {
        fileExplorer: { get: () => explorerState },
        serverInfo: { features: { fsEntryOps: true } },
      },
    },
  };
  return { ...actual, useSessionStore: (selector: (value: unknown) => unknown) => selector(state) };
});

vi.mock("@/hooks/use-file-explorer-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-file-explorer-actions")>();
  return {
    ...actual,
    useFileExplorerActions: () => ({
      requestDirectoryListing: vi.fn(async () => undefined),
      createEntry: vi.fn(),
      renameEntry: vi.fn(),
      duplicateEntry: vi.fn(),
      deleteEntry: vi.fn(),
      selectExplorerEntry: vi.fn(),
    }),
  };
});

vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock("@/hooks/use-is-local-daemon", () => ({ useIsLocalDaemon: () => false }));
vi.mock("@/hooks/use-file-download", () => ({ useFileDownload: () => vi.fn() }));
vi.mock("@/workspace/desktop-open-targets", () => ({
  useDesktopOpenTargets: () => ({ targets: [] }),
  openDesktopTarget: vi.fn(),
}));
vi.mock("@/workspace/open-in-editor/directory", () => ({ useOpenDirectoryInEditor: () => null }));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => fake.client }));
vi.mock("@/stores/workspace-layout-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/workspace-layout-store")>();
  return { ...actual, useWorkspaceLayoutStore: { getState: () => ({ openTab: fake.openTab }) } };
});
vi.mock("@/workspace-tabs/navigation", () => ({ revealWorkspaceTab: fake.revealWorkspaceTab }));
vi.mock("./content-search-panel", () => ({
  IrixContentSearchPanel: (props: (typeof fake.panelProps)[number]) => {
    fake.panelProps.push(props);
    return <div data-testid="irix-content-search-panel" />;
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
  fake.panelProps = [];
  fake.client = { id: "client" };
  fake.openTab.mockClear();
  fake.revealWorkspaceTab.mockClear();
});

async function renderPane(options: { irix: boolean }): Promise<() => void> {
  if (options.irix) vi.stubEnv("EXPO_PUBLIC_IRIX", "1");
  vi.resetModules();
  const { FileExplorerPane } = await import("@/components/file-explorer-pane");
  // After resetModules the pane sees a fresh copy of react-query, so the provider must match it.
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const queryClient = new QueryClient();
  const element = (): ReactElement => (
    <QueryClientProvider client={queryClient}>
      <FileExplorerPane serverId="server" workspaceId="workspace" workspaceRoot="/repo" />
    </QueryClientProvider>
  );
  const view = render(element());
  return () => view.rerender(element());
}

const tree = () => screen.queryByTestId("file-explorer-tree-scroll");
const panel = () => screen.queryByTestId("irix-content-search-panel");

// Every case imports the whole Files panel again after resetModules; a cold import alone can pass
// the 5 s default.
describe("Files panel content search", { timeout: 30_000 }, () => {
  it("adds no search button in an upstream build", async () => {
    await renderPane({ irix: false });
    expect(screen.getByTestId("files-new-folder")).toBeTruthy();
    expect(screen.queryByTestId("files-search")).toBeNull();
    expect(tree()).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it("swaps the tree for the search panel and back", async () => {
    await renderPane({ irix: true });
    const button = screen.getByTestId("files-search");
    expect(button.getAttribute("aria-label")).toBe("Search in files");
    expect(button.style.backgroundColor).toBe("");
    expect(tree()).toBeTruthy();
    expect(panel()).toBeNull();

    act(() => {
      fireEvent.click(button);
    });
    expect(tree()).toBeNull();
    expect(panel()).toBeTruthy();
    expect(fake.panelProps.at(-1)).toMatchObject({
      serverId: "server",
      workspaceId: "workspace",
      cwd: "/repo",
    });
    // Selected toolbar buttons get the active chrome (a background) on web.
    expect(screen.getByTestId("files-search").style.backgroundColor).not.toBe("");

    act(() => {
      fireEvent.click(screen.getByTestId("files-search"));
    });
    expect(panel()).toBeNull();
    expect(tree()).toBeTruthy();
  });

  it("opens a match through the workspace tabs with a stable callback", async () => {
    const rerender = await renderPane({ irix: true });
    act(() => {
      fireEvent.click(screen.getByTestId("files-search"));
    });
    const first = fake.panelProps.at(-1)?.onOpenMatch;
    rerender();
    expect(fake.panelProps.at(-1)?.onOpenMatch).toBe(first);

    first?.({ path: "src/app.ts", line: 42, column: 1, text: "x", ranges: [] });
    expect(fake.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceKey: "server:workspace",
        target: { kind: "file", path: "src/app.ts", lineStart: 42 },
      }),
    );
    expect(fake.revealWorkspaceTab).toHaveBeenCalledWith("server:workspace", "tab-1");
  });

  it("says the host is offline instead of asking for a longer query", async () => {
    fake.client = null;
    await renderPane({ irix: true });
    act(() => {
      fireEvent.click(screen.getByTestId("files-search"));
    });
    expect(panel()).toBeNull();
    expect(screen.getByText("Connect to the host to search")).toBeTruthy();
  });
});
