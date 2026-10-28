/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Match } from "./content-search";
import type { SearchState } from "./content-search-state";

const fake = vi.hoisted(() => ({
  state: null as unknown as SearchState,
  inputs: [] as Array<{ cwd: string | null; options: Record<string, unknown> }>,
}));

vi.mock("./use-content-search", () => ({
  useContentSearch: (input: { cwd: string | null; options: Record<string, unknown> }) => {
    fake.inputs.push({ cwd: input.cwd, options: input.options });
    return fake.state;
  },
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
}));

import { displayLine, IrixContentSearchPanel } from "./content-search-panel";

function match(path: string, line: number, text: string, start: number, end: number): Match {
  return { path, line, column: start + 1, text, ranges: [{ start, end }] };
}

const first = match("src/app.ts", 3, "const foo = 1;", 6, 9);
const second = match("src/app.ts", 9, "return foo;", 7, 10);
const third = match("README.md", 1, "foo docs", 0, 3);

function state(overrides: Partial<SearchState>): SearchState {
  return {
    requestKey: "1",
    status: "done",
    groups: [],
    matchCount: 0,
    truncated: false,
    error: null,
    ...overrides,
  };
}

const found = state({
  groups: [
    { path: "src/app.ts", matches: [first, second] },
    { path: "README.md", matches: [third] },
  ],
  matchCount: 3,
});

function renderPanel(onOpenMatch = vi.fn()) {
  render(
    <IrixContentSearchPanel
      serverId="server"
      workspaceId="workspace"
      cwd="/repo"
      onOpenMatch={onOpenMatch}
    />,
  );
  return onOpenMatch;
}

afterEach(() => {
  cleanup();
  fake.inputs = [];
});

describe("displayLine", () => {
  it("drops leading whitespace and shifts the ranges with it", () => {
    expect(displayLine("    let foo = 1;", [{ start: 8, end: 11 }])).toEqual({
      text: "let foo = 1;",
      ranges: [{ start: 4, length: 3 }],
    });
  });

  it("keeps ranges that started inside the dropped whitespace, clamped", () => {
    expect(displayLine("  ab", [{ start: 0, end: 3 }])).toEqual({
      text: "ab",
      ranges: [{ start: 0, length: 1 }],
    });
  });

  it("drops ranges that end inside the dropped whitespace", () => {
    expect(displayLine("  ab", [{ start: 0, end: 2 }])).toEqual({ text: "ab", ranges: [] });
  });
});

describe("IrixContentSearchPanel", () => {
  it("shows results grouped by file with the folder and match count", () => {
    fake.state = found;
    renderPanel();

    const files = screen.getAllByTestId("content-search-file");
    expect(files).toHaveLength(2);
    expect(files[0]?.textContent).toContain("app.ts");
    expect(files[0]?.textContent).toContain("src");
    expect(files[0]?.textContent).toContain("2");
    expect(files[1]?.textContent).toContain("README.md");
    expect(screen.getAllByTestId("content-search-result")).toHaveLength(3);
  });

  it("marks the matched range as its own run of text", () => {
    fake.state = state({
      groups: [{ path: "src/app.ts", matches: [first] }],
      matchCount: 1,
    });
    renderPanel();

    const row = screen.getByTestId("content-search-result");
    expect(row.textContent).toContain("const foo = 1;");
    const marked = screen.getByText("foo");
    expect(marked.textContent).toBe("foo");
    expect(row.contains(marked)).toBe(true);
  });

  it("shows the line number before the line text", () => {
    fake.state = state({
      groups: [{ path: "src/app.ts", matches: [first] }],
      matchCount: 1,
    });
    renderPanel();

    const row = screen.getByTestId("content-search-result");
    const lineNumber = screen.getByTestId("content-search-line-number");
    expect(lineNumber.textContent).toBe("3");
    expect(row.contains(lineNumber)).toBe(true);
    expect(row.textContent).toBe("3const foo = 1;");
  });

  it("calls onOpenMatch with the match when a row is pressed", () => {
    fake.state = found;
    const onOpenMatch = renderPanel();

    fireEvent.click(screen.getAllByTestId("content-search-result")[1]!);
    expect(onOpenMatch).toHaveBeenCalledWith(second);
  });

  it("shows the truncation line", () => {
    fake.state = { ...found, truncated: true };
    renderPanel();

    expect(screen.getByText("Results are limited. Narrow the search.")).toBeTruthy();
  });

  it("shows the error text in place of results for status error", () => {
    fake.state = state({ status: "error", error: "regex parse error" });
    renderPanel();

    expect(screen.getByText("regex parse error")).toBeTruthy();
    expect(screen.queryByTestId("content-search-result")).toBeNull();
  });

  it("keeps matches and shows a warning when done with an error", () => {
    fake.state = { ...found, error: "Permission denied: secret.txt" };
    renderPanel();

    expect(screen.getAllByTestId("content-search-result")).toHaveLength(3);
    expect(screen.getByText("Permission denied: secret.txt")).toBeTruthy();
  });

  it("shows the idle, searching and empty states", () => {
    fake.state = state({ status: "idle", requestKey: "" });
    renderPanel();
    expect(screen.getByText("Type at least 2 characters")).toBeTruthy();
    cleanup();

    fake.state = state({ status: "searching" });
    renderPanel();
    expect(screen.getByText("Searching…")).toBeTruthy();
    cleanup();

    fake.state = state({ status: "done" });
    renderPanel();
    expect(screen.getByText("No results")).toBeTruthy();
  });

  it("passes the query and toggles to the search", () => {
    fake.state = state({ status: "idle" });
    renderPanel();

    fireEvent.change(screen.getByTestId("content-search-input"), { target: { value: "foo" } });
    fireEvent.click(screen.getByTestId("content-search-case"));
    fireEvent.click(screen.getByTestId("content-search-regex"));
    fireEvent.click(screen.getByTestId("content-search-word"));

    expect(fake.inputs.at(-1)).toEqual({
      cwd: "/repo",
      options: {
        query: "foo",
        caseSensitive: true,
        regex: true,
        wholeWord: true,
        include: "",
        exclude: "",
      },
    });
    expect(screen.getByText("Rust regex syntax")).toBeTruthy();
  });

  it("reveals the include and exclude inputs on demand", () => {
    fake.state = state({ status: "idle" });
    renderPanel();
    expect(screen.queryByTestId("content-search-include")).toBeNull();

    fireEvent.click(screen.getByTestId("content-search-details"));
    fireEvent.change(screen.getByTestId("content-search-include"), {
      target: { value: "*.ts" },
    });
    fireEvent.change(screen.getByTestId("content-search-exclude"), {
      target: { value: "dist/**" },
    });

    expect(fake.inputs.at(-1)?.options).toMatchObject({ include: "*.ts", exclude: "dist/**" });
  });
});
