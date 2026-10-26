/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const build = vi.hoisted(() => ({ irix: false }));
const host = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  patchConfig: vi.fn(async (_patch: unknown) => ({})),
  pick: (_value: string) => {},
}));

vi.mock("@/irix/build", () => ({
  get IRIX_BUILD() {
    return build.irix;
  },
  HIDDEN_ROW_STYLE: {},
  upstreamOnly: <T,>(component: T) => component,
}));
vi.mock("@/stores/session-store", () => ({ useSessionStore: () => undefined }));
vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: host.config, isLoading: false, patchConfig: host.patchConfig }),
}));
vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: (props: { onValueChange: (value: string) => void; testID?: string }) => {
    host.pick = props.onValueChange;
    return <div data-testid={props.testID} />;
  },
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeIsConnected: () => true }));
vi.mock("@/components/ui/switch", () => ({ Switch: () => null }));
vi.mock("@/components/ui/form-field", () => ({ FormTextInput: () => null }));

import { irixAgentsCard } from "./subagent-approval-setting";

afterEach(cleanup);

describe("irixAgentsCard", () => {
  it("returns the upstream component untouched outside Irix builds", () => {
    build.irix = false;
    const Upstream = () => null;
    expect(irixAgentsCard(Upstream)).toBe(Upstream);
  });

  it("renders the subagent approval card then the idle release card in Irix builds", () => {
    build.irix = true;
    const Card = irixAgentsCard((_props: { serverId: string }) => null);
    const view = render(<Card serverId="s1" />);
    const approval = view.getByTestId("host-page-subagent-approval-card");
    const idle = view.getByTestId("host-page-idle-release-card");
    expect(approval.compareDocumentPosition(idle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides the agent tools choice while the daemon keeps it fixed", () => {
    build.irix = true;
    host.config = { agentToolsEditable: false };
    const Card = irixAgentsCard((_props: { serverId: string }) => null);
    const view = render(<Card serverId="s1" />);
    expect(view.queryByTestId("host-page-agent-tools-card")).toBeNull();
  });

  it("offers the agent tools choice after idle release once it may be changed, and saves it", () => {
    build.irix = true;
    host.config = { agentToolsEditable: true, agentTools: "cli" };
    host.patchConfig.mockClear();
    const Card = irixAgentsCard((_props: { serverId: string }) => null);
    const view = render(<Card serverId="s1" />);
    const idle = view.getByTestId("host-page-idle-release-card");
    const tools = view.getByTestId("host-page-agent-tools-card");
    expect(idle.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.getByTestId("host-page-agent-tools-control")).toBeTruthy();
    act(() => host.pick("mcp"));
    expect(host.patchConfig).toHaveBeenCalledWith({ agentTools: "mcp" });
  });
});
