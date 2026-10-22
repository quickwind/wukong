/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connected: true,
  config: {} as Record<string, unknown>,
  patchConfig: vi.fn(async (_patch: unknown) => {}),
  alert: vi.fn(),
}));

vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  return { ...actual, Alert: { alert: state.alert } };
});

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: state.config,
    isLoading: false,
    patchConfig: state.patchConfig,
  }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => state.connected,
}));

vi.mock("@/components/ui/switch", async () => {
  const { useCallback } = await import("react");
  return {
    Switch: function SwitchStub(props: {
      value: boolean;
      disabled?: boolean;
      onValueChange?: (value: boolean) => void;
      testID?: string;
    }) {
      const { onValueChange } = props;
      const onChange = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => onValueChange?.(event.target.checked),
        [onValueChange],
      );
      return (
        <input
          type="checkbox"
          data-testid={props.testID}
          checked={props.value}
          disabled={props.disabled}
          onChange={onChange}
        />
      );
    },
  };
});

vi.mock("@/components/ui/form-field", async () => {
  const { useCallback, useEffect, useRef, useState } = await import("react");
  return {
    FormTextInput: function FormTextInputStub(props: {
      initialValue?: string;
      resetKey?: string | number;
      editable?: boolean;
      onChangeText?: (value: string) => void;
      onBlur?: () => void;
      onSubmitEditing?: () => void;
      testID?: string;
    }) {
      const { onChangeText, onSubmitEditing, initialValue, resetKey } = props;
      // Like the real EditingTextInput: text is captured once and replaced only when resetKey changes.
      const [text, setText] = useState(initialValue ?? "");
      const initialRef = useRef(initialValue);
      initialRef.current = initialValue;
      useEffect(() => {
        setText(initialRef.current ?? "");
      }, [resetKey]);
      const onChange = useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
          setText(event.target.value);
          onChangeText?.(event.target.value);
        },
        [onChangeText],
      );
      const onKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
          if (event.key === "Enter") onSubmitEditing?.();
        },
        [onSubmitEditing],
      );
      return (
        <input
          data-testid={props.testID}
          value={text}
          disabled={props.editable === false}
          onChange={onChange}
          onBlur={props.onBlur}
          onKeyDown={onKeyDown}
        />
      );
    },
  };
});

import { IrixIdleReleaseCard } from "./idle-release-setting";

beforeEach(() => {
  state.connected = true;
  state.config = {};
  state.patchConfig.mockClear();
  state.patchConfig.mockImplementation(async () => {});
  state.alert.mockClear();
});
afterEach(cleanup);

function renderCard() {
  return render(<IrixIdleReleaseCard serverId="s1" />);
}

describe("IrixIdleReleaseCard", () => {
  it("defaults to on with 15 minutes when config lacks idleRelease", () => {
    const view = renderCard();
    expect((view.getByTestId("host-page-idle-release-switch") as HTMLInputElement).checked).toBe(
      true,
    );
    expect((view.getByTestId("host-page-idle-release-minutes") as HTMLInputElement).value).toBe(
      "15",
    );
    expect(view.getByText("Release idle agents")).toBeTruthy();
    expect(
      view.getByText(
        "Close an idle Claude or Devin agent's process after 15 minutes. The chat stays; it reopens when you open it or send a message.",
      ),
    ).toBeTruthy();
  });

  it("shows the persisted value and the off hint", () => {
    state.config = { idleRelease: { enabled: false, minutes: 40 } };
    const view = renderCard();
    expect((view.getByTestId("host-page-idle-release-switch") as HTMLInputElement).checked).toBe(
      false,
    );
    expect((view.getByTestId("host-page-idle-release-minutes") as HTMLInputElement).value).toBe(
      "40",
    );
    expect(
      view.getByText("Idle agents keep their process until the daemon restarts."),
    ).toBeTruthy();
  });

  it("patches enabled when toggled", () => {
    const view = renderCard();
    fireEvent.click(view.getByTestId("host-page-idle-release-switch"));
    expect(state.patchConfig).toHaveBeenCalledWith({ idleRelease: { enabled: false } });
  });

  it("patches minutes on blur with a valid value", () => {
    const view = renderCard();
    const input = view.getByTestId("host-page-idle-release-minutes");
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.blur(input);
    expect(state.patchConfig).toHaveBeenCalledWith({ idleRelease: { minutes: 30 } });
  });

  it("patches minutes on submit", () => {
    const view = renderCard();
    const input = view.getByTestId("host-page-idle-release-minutes");
    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(state.patchConfig).toHaveBeenCalledWith({ idleRelease: { minutes: 45 } });
  });

  it.each(["0", "1441", "1.5", "abc", ""])("rejects %j with an inline error", (value) => {
    const view = renderCard();
    const input = view.getByTestId("host-page-idle-release-minutes");
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    expect(state.patchConfig).not.toHaveBeenCalled();
    expect(view.getByText("Enter a whole number from 1 to 1440.")).toBeTruthy();
  });

  it("does not patch when the minutes are unchanged", () => {
    const view = renderCard();
    fireEvent.blur(view.getByTestId("host-page-idle-release-minutes"));
    expect(state.patchConfig).not.toHaveBeenCalled();
  });

  it("alerts when the patch fails", async () => {
    state.patchConfig.mockRejectedValueOnce(new Error("boom"));
    const view = renderCard();
    await act(async () => {
      fireEvent.click(view.getByTestId("host-page-idle-release-switch"));
    });
    expect(state.alert).toHaveBeenCalledWith("Unable to update setting", "boom");
  });

  it("reverts the field to the persisted value when the patch fails", async () => {
    state.patchConfig.mockRejectedValueOnce(new Error("boom"));
    const view = renderCard();
    const input = view.getByTestId("host-page-idle-release-minutes") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "30" } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(input.value).toBe("15");
  });

  it("follows an external change of the persisted minutes", () => {
    const view = renderCard();
    state.config = { idleRelease: { enabled: true, minutes: 40 } };
    view.rerender(<IrixIdleReleaseCard serverId="s1" />);
    expect((view.getByTestId("host-page-idle-release-minutes") as HTMLInputElement).value).toBe(
      "40",
    );
  });

  it("renders nothing when disconnected", () => {
    state.connected = false;
    const view = renderCard();
    expect(view.queryByTestId("host-page-idle-release-card")).toBeNull();
  });
});
