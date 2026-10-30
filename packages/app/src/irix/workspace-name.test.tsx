/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelDescriptor } from "@/panels/panel-registry";

const build = vi.hoisted(() => ({ irix: false }));

vi.mock("@/irix/build", () => ({
  get IRIX_BUILD() {
    return build.irix;
  },
  HIDDEN_ROW_STYLE: {},
  upstreamOnly: <T,>(component: T) => component,
}));

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

import {
  IrixCreateAgentBar,
  IrixCreateWorkspaceBar,
  irixAgentTitleField,
  irixWorkspaceTitleField,
  useIrixDraftDescriptor,
} from "./workspace-name";

// The name boxes keep typed names in module state, so every test uses a draft id of its own and
// unmounts its screen when it is done.
let draftSeq = 0;
function freshDraft(): string {
  draftSeq += 1;
  return `draft-${draftSeq}`;
}

beforeEach(() => {
  build.irix = true;
});

afterEach(() => {
  cleanup();
});

function typeName(testId: string, value: string) {
  fireEvent.change(document.querySelector(`[data-testid="${testId}"]`) as Element, {
    target: { value },
  });
}

describe("IrixCreateWorkspaceBar", () => {
  it("renders nothing in an upstream build", () => {
    build.irix = false;
    const view = render(<IrixCreateWorkspaceBar submit={vi.fn(async () => {})} pending={false} />);
    expect(view.queryByTestId("irix-name-workspace")).toBeNull();
    expect(view.container.textContent).toBe("");
  });

  it("shows the name box and a Create workspace button in an Irix build", () => {
    const view = render(<IrixCreateWorkspaceBar submit={vi.fn(async () => {})} pending={false} />);
    expect(view.getByTestId("irix-name-workspace").getAttribute("placeholder")).toMatch(
      /^Workspace name/u,
    );
    expect(view.getByTestId("irix-create-workspace").textContent).toBe("Create workspace");
  });

  it("submits an empty workspace in the screen's own directory when Create is pressed", () => {
    const submit = vi.fn(async () => {});
    const view = render(<IrixCreateWorkspaceBar submit={submit} pending={false} />);
    fireEvent.click(view.getByTestId("irix-create-workspace"));
    expect(submit).toHaveBeenCalledWith({ text: "", attachments: [], cwd: "" });
  });

  it("disables the name box and the button while a create is pending", () => {
    const view = render(<IrixCreateWorkspaceBar submit={vi.fn(async () => {})} pending />);
    expect(view.getByTestId("irix-name-workspace").hasAttribute("readonly")).toBe(true);
    expect(view.getByTestId("irix-create-workspace").hasAttribute("disabled")).toBe(true);
  });

  it("carries the typed name as the workspace title, trimmed", () => {
    const view = render(<IrixCreateWorkspaceBar submit={vi.fn(async () => {})} pending={false} />);
    expect(irixWorkspaceTitleField()).toEqual({});
    typeName("irix-name-workspace", "  Research  ");
    expect(irixWorkspaceTitleField()).toEqual({ title: "Research" });
    view.unmount();
    expect(irixWorkspaceTitleField()).toEqual({});
  });

  it("gives no title for a name that is only spaces", () => {
    const view = render(<IrixCreateWorkspaceBar submit={vi.fn(async () => {})} pending={false} />);
    typeName("irix-name-workspace", "   ");
    expect(irixWorkspaceTitleField()).toEqual({});
    view.unmount();
  });

  it("gives no workspace title in an upstream build, even with a name typed", () => {
    const view = render(<IrixCreateWorkspaceBar submit={vi.fn(async () => {})} pending={false} />);
    typeName("irix-name-workspace", "Research");
    build.irix = false;
    expect(irixWorkspaceTitleField()).toEqual({});
    view.unmount();
  });
});

describe("IrixCreateAgentBar", () => {
  it("renders nothing in an upstream build", () => {
    build.irix = false;
    const view = render(<IrixCreateAgentBar draftId={freshDraft()} />);
    expect(view.container.textContent).toBe("");
  });

  it("asks for a chat name and offers Create chat", () => {
    const draftId = freshDraft();
    const view = render(<IrixCreateAgentBar draftId={draftId} />);
    expect(view.getByTestId(`irix-name-${draftId}`).getAttribute("placeholder")).toMatch(
      /^Chat name/u,
    );
    expect(view.getByTestId(`irix-create-${draftId}`).textContent).toBe("Create chat");
  });

  it("refuses an empty name with a message and keeps the bar", () => {
    const draftId = freshDraft();
    const view = render(<IrixCreateAgentBar draftId={draftId} />);
    fireEvent.click(view.getByTestId(`irix-create-${draftId}`));
    expect(view.getByText("Give the chat a name, or just type your first message.")).toBeTruthy();
    expect(view.getByTestId(`irix-name-${draftId}`)).toBeTruthy();
  });

  it("clears the refusal once the name is typed", () => {
    const draftId = freshDraft();
    const view = render(<IrixCreateAgentBar draftId={draftId} />);
    fireEvent.click(view.getByTestId(`irix-create-${draftId}`));
    typeName(`irix-name-${draftId}`, "P");
    expect(view.queryByText("Give the chat a name, or just type your first message.")).toBeNull();
  });

  it("titles the draft with the name on Create chat, and hides the bar", () => {
    const draftId = freshDraft();
    const view = render(<IrixCreateAgentBar draftId={draftId} />);
    typeName(`irix-name-${draftId}`, "Plan the release");
    fireEvent.click(view.getByTestId(`irix-create-${draftId}`));
    expect(view.queryByTestId(`irix-name-${draftId}`)).toBeNull();
    expect(irixAgentTitleField(draftId)).toEqual({ title: "Plan the release" });
  });

  it("gives the typed name as the agent title before Create is pressed, as the first message is sent", () => {
    const draftId = freshDraft();
    const view = render(<IrixCreateAgentBar draftId={draftId} />);
    typeName(`irix-name-${draftId}`, "Draft name");
    expect(irixAgentTitleField(draftId)).toEqual({ title: "Draft name" });
    view.unmount();
  });

  it("gives no agent title for a draft nobody named", () => {
    expect(irixAgentTitleField(freshDraft())).toEqual({});
  });

  it("gives no agent title in an upstream build, even with a name typed", () => {
    const draftId = freshDraft();
    const view = render(<IrixCreateAgentBar draftId={draftId} />);
    typeName(`irix-name-${draftId}`, "Named");
    build.irix = false;
    expect(irixAgentTitleField(draftId)).toEqual({});
    view.unmount();
  });
});

describe("useIrixDraftDescriptor", () => {
  const descriptor = { label: "New chat", tooltip: "New chat" } as unknown as PanelDescriptor;

  it("keeps the descriptor for a draft that has no name", () => {
    const { result } = renderHook(() => useIrixDraftDescriptor(descriptor, freshDraft()));
    expect(result.current).toBe(descriptor);
  });

  it("titles the draft tab with the confirmed name", () => {
    const draftId = freshDraft();
    const bar = render(<IrixCreateAgentBar draftId={draftId} />);
    typeName(`irix-name-${draftId}`, "Plan");
    fireEvent.click(bar.getByTestId(`irix-create-${draftId}`));
    const { result } = renderHook(() => useIrixDraftDescriptor(descriptor, draftId));
    expect(result.current).toMatchObject({ label: "Plan", tooltip: "Plan" });
  });

  it("keeps the upstream descriptor in an upstream build, even with a name confirmed", () => {
    const draftId = freshDraft();
    const bar = render(<IrixCreateAgentBar draftId={draftId} />);
    typeName(`irix-name-${draftId}`, "Plan");
    fireEvent.click(bar.getByTestId(`irix-create-${draftId}`));
    build.irix = false;
    const { result } = renderHook(() => useIrixDraftDescriptor(descriptor, draftId));
    expect(result.current).toBe(descriptor);
    bar.unmount();
  });
});
