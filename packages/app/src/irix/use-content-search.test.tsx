// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentSearchClient } from "./content-search";
import { DEBOUNCE_MS, POLL_INTERVAL_MS } from "./content-search-state";
import { useContentSearch } from "./use-content-search";

const hit = { path: "a.ts", line: 1, column: 1, text: "foo", ranges: [{ start: 0, end: 3 }] };

interface Fake {
  client: ContentSearchClient;
  calls: string[];
  polls: Array<{ batch: unknown[]; done: boolean }>;
}

function fakeClient(polls: Fake["polls"]): Fake {
  const calls: string[] = [];
  let started = 0;
  const client: ContentSearchClient = {
    invokePluginRpc: async (_plugin, method, input) => {
      if (method === "irix.search.content.start") {
        started += 1;
        calls.push(`start:${(input as { query: string }).query}`);
        return { id: `s${started}` };
      }
      if (method === "irix.search.content.poll") {
        calls.push(`poll:${(input as { id: string }).id}`);
        const next = polls.shift() ?? { batch: [], done: true };
        return { ...next, cursor: 0, truncated: false, error: null };
      }
      calls.push(`cancel:${(input as { id: string }).id}`);
      return {};
    },
  };
  return { client, calls, polls };
}

const baseOptions = {
  query: "foo",
  caseSensitive: false,
  regex: false,
  wholeWord: false,
  include: "",
  exclude: "",
};

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useContentSearch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays idle for a short query", async () => {
    const fake = fakeClient([]);
    const { result } = renderHook(() =>
      useContentSearch({ client: fake.client, cwd: "/r", options: { ...baseOptions, query: "f" } }),
    );
    await advance(DEBOUNCE_MS * 5);
    expect(result.current.status).toBe("idle");
    expect(fake.calls).toEqual([]);
  });

  it("debounces, then polls every interval until done", async () => {
    const fake = fakeClient([
      { batch: [hit], done: false },
      { batch: [], done: true },
    ]);
    const { result } = renderHook(() =>
      useContentSearch({ client: fake.client, cwd: "/r", options: baseOptions }),
    );
    await advance(DEBOUNCE_MS - 1);
    expect(fake.calls).toEqual([]);
    await advance(1);
    expect(fake.calls).toEqual(["start:foo", "poll:s1"]);
    expect(result.current.status).toBe("searching");
    expect(result.current.matchCount).toBe(1);
    await advance(POLL_INTERVAL_MS - 1);
    expect(fake.calls).toEqual(["start:foo", "poll:s1"]);
    await advance(1);
    expect(fake.calls).toEqual(["start:foo", "poll:s1", "poll:s1"]);
    expect(result.current.status).toBe("done");
    await advance(POLL_INTERVAL_MS * 3);
    expect(fake.calls).toHaveLength(3);
  });

  it("cancels the running search when the query changes, before starting the next", async () => {
    const fake = fakeClient([{ batch: [], done: false }]);
    const { rerender } = renderHook(
      ({ query }) =>
        useContentSearch({ client: fake.client, cwd: "/r", options: { ...baseOptions, query } }),
      { initialProps: { query: "foo" } },
    );
    await advance(DEBOUNCE_MS);
    expect(fake.calls).toEqual(["start:foo", "poll:s1"]);
    rerender({ query: "foob" });
    await advance(0);
    expect(fake.calls).toEqual(["start:foo", "poll:s1", "cancel:s1"]);
    await advance(DEBOUNCE_MS);
    expect(fake.calls[3]).toBe("start:foob");
  });

  it("cancels on unmount", async () => {
    const fake = fakeClient([{ batch: [], done: false }]);
    const { unmount } = renderHook(() =>
      useContentSearch({ client: fake.client, cwd: "/r", options: baseOptions }),
    );
    await advance(DEBOUNCE_MS);
    unmount();
    await advance(POLL_INTERVAL_MS * 3);
    expect(fake.calls).toEqual(["start:foo", "poll:s1", "cancel:s1"]);
  });

  it("reports a missing plugin as an unavailable search", async () => {
    const client: ContentSearchClient = {
      invokePluginRpc: async () => {
        throw new Error("Unknown plugin");
      },
    };
    const { result } = renderHook(() =>
      useContentSearch({ client, cwd: "/r", options: baseOptions }),
    );
    await advance(DEBOUNCE_MS);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Search is not available on this host. Update the host.");
  });
});
