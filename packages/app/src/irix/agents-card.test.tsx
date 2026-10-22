/** @vitest-environment jsdom */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const build = vi.hoisted(() => ({ irix: false }));

vi.mock("@/irix/build", () => ({
  get IRIX_BUILD() {
    return build.irix;
  },
  HIDDEN_ROW_STYLE: {},
  upstreamOnly: <T,>(component: T) => component,
}));
vi.mock("@/stores/session-store", () => ({ useSessionStore: () => undefined }));
vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: {}, isLoading: false, patchConfig: vi.fn() }),
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
});
