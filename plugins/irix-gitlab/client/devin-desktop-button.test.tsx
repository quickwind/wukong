import type {
  PluginButtonRegistration,
  PluginClientContext,
  PluginCommandCenterItemContribution,
  PluginHeaderButtonContribution,
} from "@getpaseo/plugin/client";
import { describe, expect, it } from "vitest";
import { contributeDevinDesktopButton } from "./devin-desktop-button.js";

interface FakeHarnessOptions {
  installed: boolean;
  iconDataUrl?: string | null;
  initialWorkspaces?: Array<{ id: string; workspaceDirectory: string }>;
}

function createFakeClient(options: FakeHarnessOptions) {
  const headerButtons = new Map<string, PluginHeaderButtonContribution>();
  const removedButtons: string[] = [];
  const commandCenterItems: PluginCommandCenterItemContribution[] = [];
  const openCalls: string[] = [];
  let workspaceObserver: {
    snapshot: (data: { entries: Array<{ id: string; workspaceDirectory: string }> }) => void;
    update: (msg: unknown) => void;
  } | null = null;

  const client = {
    async rpc(contract: { name: string }, input: unknown) {
      if (contract.name === "irix.devin-desktop.status") {
        return {
          installed: options.installed,
          iconDataUrl: options.iconDataUrl ?? null,
        };
      }
      if (contract.name === "irix.devin-desktop.open") {
        openCalls.push((input as { workspacePath: string }).workspacePath);
        return { ok: true as const };
      }
      throw new Error(`Unexpected RPC: ${contract.name}`);
    },
    addHeaderButton(contribution: PluginHeaderButtonContribution): PluginButtonRegistration {
      const key = `${contribution.workspaceId}:${contribution.id}`;
      headerButtons.set(key, contribution);
      return {
        update(patch) {
          const existing = headerButtons.get(key);
          if (existing) {
            headerButtons.set(key, { ...existing, button: { ...existing.button, ...patch } });
          }
        },
        remove() {
          headerButtons.delete(key);
          removedButtons.push(key);
        },
      };
    },
    addCommandCenterItem(contribution: PluginCommandCenterItemContribution) {
      commandCenterItems.push(contribution);
      return () => {
        const idx = commandCenterItems.indexOf(contribution);
        if (idx >= 0) commandCenterItems.splice(idx, 1);
      };
    },
    paseo: {
      workspaces: {
        async list() {
          return {
            requestId: "req-1",
            entries: options.initialWorkspaces ?? [],
            pageInfo: { hasMore: false, nextCursor: null },
            subscriptionId: "sub-1",
            subscription: {
              subscribe(handlers: typeof workspaceObserver) {
                workspaceObserver = handlers;
                handlers?.snapshot({ entries: options.initialWorkspaces ?? [] });
                return () => {};
              },
              async release() {},
            },
          };
        },
      },
    },
  } as unknown as PluginClientContext;

  return {
    client,
    headerButtons,
    removedButtons,
    commandCenterItems,
    openCalls,
    emitWorkspaceUpdate(payload: unknown) {
      workspaceObserver?.update({ type: "workspace_update", payload });
    },
  };
}

describe("contributeDevinDesktopButton", () => {
  it("registers nothing when Devin Desktop is not installed", async () => {
    const harness = createFakeClient({
      installed: false,
      initialWorkspaces: [{ id: "ws-1", workspaceDirectory: "C:\\Work\\repo" }],
    });

    const cleanup = contributeDevinDesktopButton(harness.client);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.headerButtons.size).toBe(0);
    expect(harness.commandCenterItems).toHaveLength(0);
    cleanup();
  });

  it("registers header buttons for workspaces when installed and opens Devin Desktop on press", async () => {
    const harness = createFakeClient({
      installed: true,
      iconDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
      initialWorkspaces: [{ id: "ws-1", workspaceDirectory: "C:\\Work\\repo" }],
    });

    const cleanup = contributeDevinDesktopButton(harness.client);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.headerButtons.size).toBe(1);
    expect(harness.commandCenterItems).toHaveLength(1);
    const button = harness.headerButtons.get("ws-1:open-in-devin");
    expect(button?.button.title).toBe("Open in Devin");
    expect(typeof button?.button.icon).toBe("function");

    if (button?.button.behavior.kind === "action") {
      await button.button.behavior.onPress();
    }
    expect(harness.openCalls).toEqual(["C:\\Work\\repo"]);

    harness.emitWorkspaceUpdate({
      kind: "upsert",
      workspace: { id: "ws-2", workspaceDirectory: "C:\\Work\\second" },
    });
    expect(harness.headerButtons.has("ws-2:open-in-devin")).toBe(true);

    harness.emitWorkspaceUpdate({
      kind: "remove",
      id: "ws-1",
    });
    expect(harness.headerButtons.has("ws-1:open-in-devin")).toBe(false);

    cleanup();
    expect(harness.headerButtons.size).toBe(0);
    expect(harness.commandCenterItems).toHaveLength(0);
  });
});
