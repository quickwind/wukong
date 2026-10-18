/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";

const host = vi.hoisted(() => ({
  prepareAgentTimeline: vi.fn(async (_serverId: string, _agentId: string) => {}),
  sessions: {} as Record<string, { viewedTimelineSync: unknown } | undefined>,
  listeners: new Set<() => void>(),
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ prepareAgentTimeline: host.prepareAgentTimeline }),
}));

// The real store pulls in the whole app; the shell reads one field of one session.
vi.mock("@/stores/session-store", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useSessionStore: <T,>(selector: (state: { sessions: typeof host.sessions }) => T): T => {
      const snapshot = useSyncExternalStore(
        (listener) => {
          host.listeners.add(listener);
          return () => host.listeners.delete(listener);
        },
        () => host.sessions,
      );
      return selector({ sessions: snapshot });
    },
  };
});

// The conversation needs a daemon; what the shell owes it is its context.
vi.mock("@/panels/agent-panel", () => ({
  AgentConversationPanel: function Probe() {
    const pane = usePaneContext();
    const focus = usePaneFocus();
    const agentId = pane.target.kind === "agent" ? pane.target.agentId : "other";
    return (
      <div
        data-testid={`probe-${agentId}`}
        data-target={agentId}
        data-tab={pane.tabId}
        data-workspace={pane.workspaceId}
        data-interactive={String(focus.isInteractive)}
      />
    );
  },
}));

import { AgentViewShell } from "./agent-view-shell";

function installSync(serverId: string) {
  const sync = { replaceVisibleAgentIds: vi.fn() };
  host.sessions = { ...host.sessions, [serverId]: { viewedTimelineSync: sync } };
  act(() => {
    for (const listener of host.listeners) listener();
  });
  return sync;
}

afterEach(() => {
  cleanup();
  host.sessions = {};
  host.prepareAgentTimeline.mockClear();
});

const view = (agentId: string) => (
  <AgentViewShell agentId={agentId} serverId="srv" workspaceId="wks" />
);

function probe(container: HTMLElement, agentId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="probe-${agentId}"]`);
}

describe("AgentViewShell", () => {
  it("gives the conversation a pane for the agent and registers it as viewed", () => {
    const sync = installSync("srv");
    const { container } = render(view("a"));

    expect(probe(container, "a")?.dataset).toMatchObject({
      target: "a",
      workspace: "wks",
      interactive: "true",
    });
    expect(host.prepareAgentTimeline).toHaveBeenCalledWith("srv", "a");
    expect(sync.replaceVisibleAgentIds).toHaveBeenCalledWith(expect.any(String), ["a"]);
  });

  it("follows a change of agentId and releases the previous agent", () => {
    const sync = installSync("srv");
    const { container, rerender } = render(view("a"));
    const sourceId = sync.replaceVisibleAgentIds.mock.calls[0]?.[0];

    rerender(view("b"));

    expect(probe(container, "a")).toBeNull();
    expect(probe(container, "b")?.dataset.target).toBe("b");
    expect(sync.replaceVisibleAgentIds.mock.calls).toEqual([
      [sourceId, ["a"]],
      [sourceId, []],
      [sourceId, ["b"]],
    ]);
    expect(host.prepareAgentTimeline).toHaveBeenLastCalledWith("srv", "b");
  });

  it("keeps two views apart: separate sources, separate tabs, independent release", () => {
    const sync = installSync("srv");
    const first = render(view("a"));
    const second = render(view("b"));

    const sources = new Map(
      sync.replaceVisibleAgentIds.mock.calls.map(([source, ids]) => [ids[0], source]),
    );
    expect(sources.get("a")).toBeTypeOf("string");
    expect(sources.get("b")).toBeTypeOf("string");
    expect(sources.get("a")).not.toBe(sources.get("b"));
    expect(probe(first.container, "a")?.dataset.tab).not.toBe(
      probe(second.container, "b")?.dataset.tab,
    );

    first.unmount();

    expect(sync.replaceVisibleAgentIds).toHaveBeenLastCalledWith(sources.get("a"), []);
    expect(sync.replaceVisibleAgentIds).not.toHaveBeenCalledWith(sources.get("b"), []);
    expect(probe(second.container, "b")).not.toBeNull();
  });

  it("registers once the host's session exists", () => {
    const { container } = render(view("a"));
    expect(probe(container, "a")).not.toBeNull();

    const sync = installSync("srv");

    expect(sync.replaceVisibleAgentIds).toHaveBeenCalledWith(expect.any(String), ["a"]);
  });
});
