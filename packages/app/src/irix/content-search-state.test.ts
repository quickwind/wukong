import { describe, expect, it } from "vitest";

import type { Match } from "./content-search";
import { reduceSearch, shouldSearch, type SearchState } from "./content-search-state";

function match(path: string, line: number): Match {
  return { path, line, column: 1, text: "x", ranges: [{ start: 0, end: 1 }] };
}

const idle: SearchState = {
  requestKey: "k1",
  status: "idle",
  groups: [],
  matchCount: 0,
  truncated: false,
  error: null,
};

function searching(): SearchState {
  return reduceSearch(idle, { type: "reset", requestKey: "k1" });
}

describe("shouldSearch", () => {
  it("needs two characters after trimming", () => {
    expect(shouldSearch("a")).toBe(false);
    expect(shouldSearch(" a ")).toBe(false);
    expect(shouldSearch(" ab ")).toBe(true);
  });
});

describe("reduceSearch", () => {
  it("reset starts a fresh search under the new key", () => {
    const old = reduceSearch(searching(), {
      type: "batch",
      requestKey: "k1",
      batch: [match("a", 1)],
      done: true,
      truncated: true,
    });
    const next = reduceSearch(old, { type: "reset", requestKey: "k2" });
    expect(next).toEqual({ ...idle, requestKey: "k2", status: "searching" });
  });

  it("groups matches by path in arrival order across batches", () => {
    let state = searching();
    state = reduceSearch(state, {
      type: "batch",
      requestKey: "k1",
      batch: [match("b", 1), match("a", 2), match("b", 3)],
      done: false,
      truncated: false,
    });
    state = reduceSearch(state, {
      type: "batch",
      requestKey: "k1",
      batch: [match("a", 9)],
      done: false,
      truncated: false,
    });
    const lines = (matches: Match[]) => matches.map((m) => m.line);
    expect(state.groups.map((g) => [g.path, lines(g.matches)])).toEqual([
      ["b", [1, 3]],
      ["a", [2, 9]],
    ]);
    expect(state.matchCount).toBe(4);
    expect(state.status).toBe("searching");
  });

  it("is done only when the batch says so, and carries truncated", () => {
    const state = reduceSearch(searching(), {
      type: "batch",
      requestKey: "k1",
      batch: [],
      done: true,
      truncated: true,
    });
    expect(state.status).toBe("done");
    expect(state.truncated).toBe(true);
  });

  it("ignores actions from a stale request", () => {
    const state = searching();
    expect(
      reduceSearch(state, {
        type: "batch",
        requestKey: "old",
        batch: [match("a", 1)],
        done: true,
        truncated: false,
      }),
    ).toBe(state);
    expect(reduceSearch(state, { type: "failed", requestKey: "old", message: "x" })).toBe(state);
  });

  it("failed sets the error status", () => {
    const state = reduceSearch(searching(), { type: "failed", requestKey: "k1", message: "boom" });
    expect(state.status).toBe("error");
    expect(state.error).toBe("boom");
  });

  it("keeps matches when a finished search reports a partial failure", () => {
    let state = reduceSearch(searching(), {
      type: "batch",
      requestKey: "k1",
      batch: [match("a", 1)],
      done: false,
      truncated: false,
    });
    state = reduceSearch(state, {
      type: "batch",
      requestKey: "k1",
      batch: [],
      done: true,
      truncated: false,
      error: "a/locked: permission denied",
    });
    expect(state.status).toBe("done");
    expect(state.error).toBe("a/locked: permission denied");
    expect(state.matchCount).toBe(1);
  });

  it("counts matches in the final batch when deciding a partial failure", () => {
    const state = reduceSearch(searching(), {
      type: "batch",
      requestKey: "k1",
      batch: [match("a", 1)],
      done: true,
      truncated: false,
      error: "partial",
    });
    expect(state.status).toBe("done");
    expect(state.error).toBe("partial");
  });

  it("is an error when the search finished with an error and no matches", () => {
    const state = reduceSearch(searching(), {
      type: "batch",
      requestKey: "k1",
      batch: [],
      done: true,
      truncated: false,
      error: "Search expired",
    });
    expect(state.status).toBe("error");
    expect(state.error).toBe("Search expired");
  });
});
