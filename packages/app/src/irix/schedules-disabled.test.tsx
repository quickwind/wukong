/** @vitest-environment jsdom */
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "@/stores/session-store";

const build = vi.hoisted(() => ({ irix: false }));

vi.mock("@/irix/build", () => ({
  get IRIX_BUILD() {
    return build.irix;
  },
  HIDDEN_ROW_STYLE: {},
  upstreamOnly: <T,>(component: T) => component,
}));

import { hideWhenSchedulesDisabled, useSchedulesDisabled } from "./schedules-disabled";

const initialSessions = useSessionStore.getState().sessions;

function setSessions(features: Record<string, unknown> | null) {
  const sessions = features
    ? { server: { serverInfo: { features } } }
    : { server: { serverInfo: null } };
  act(() => {
    useSessionStore.setState({ sessions } as never);
  });
}

function Row() {
  return <div data-testid="schedules-row" />;
}

beforeEach(() => {
  build.irix = true;
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessions: initialSessions } as never);
});

describe("useSchedulesDisabled", () => {
  it("is false when no daemon is connected", () => {
    setSessions(null);
    const { result } = renderHook(() => useSchedulesDisabled());
    expect(result.current).toBe(false);
  });

  it("is true when a connected daemon reports schedulesDisabled", () => {
    setSessions({ schedulesDisabled: true });
    const { result } = renderHook(() => useSchedulesDisabled());
    expect(result.current).toBe(true);
  });

  it("is false when the daemon reports schedules on", () => {
    setSessions({ schedulesDisabled: false });
    const { result } = renderHook(() => useSchedulesDisabled());
    expect(result.current).toBe(false);
  });

  it("is always false in an upstream build", () => {
    build.irix = false;
    setSessions({ schedulesDisabled: true });
    const { result } = renderHook(() => useSchedulesDisabled());
    expect(result.current).toBe(false);
  });
});

describe("hideWhenSchedulesDisabled", () => {
  it("renders the component while schedules are on", () => {
    setSessions({ schedulesDisabled: false });
    const Wrapped = hideWhenSchedulesDisabled(Row);
    const view = render(<Wrapped />);
    expect(view.queryByTestId("schedules-row")).not.toBeNull();
  });

  it("renders nothing while the connected daemon has schedules switched off", () => {
    setSessions({ schedulesDisabled: true });
    const Wrapped = hideWhenSchedulesDisabled(Row);
    const view = render(<Wrapped />);
    expect(view.queryByTestId("schedules-row")).toBeNull();
  });

  it("shows the row again when the daemon's switch comes back on", () => {
    setSessions({ schedulesDisabled: true });
    const Wrapped = hideWhenSchedulesDisabled(Row);
    const view = render(<Wrapped />);
    expect(view.queryByTestId("schedules-row")).toBeNull();
    setSessions({ schedulesDisabled: false });
    expect(view.queryByTestId("schedules-row")).not.toBeNull();
  });

  it("never hides the row in an upstream build", () => {
    build.irix = false;
    setSessions({ schedulesDisabled: true });
    const Wrapped = hideWhenSchedulesDisabled(Row);
    const view = render(<Wrapped />);
    expect(view.queryByTestId("schedules-row")).not.toBeNull();
  });

  it("passes props through to the component", () => {
    setSessions({ schedulesDisabled: false });
    const Labelled = hideWhenSchedulesDisabled(({ label }: { label: string }) => (
      <div data-testid="labelled">{label}</div>
    ));
    const view = render(<Labelled label="Schedules" />);
    expect(view.getByTestId("labelled").textContent).toBe("Schedules");
  });
});
