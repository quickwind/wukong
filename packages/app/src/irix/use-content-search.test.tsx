// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContentSearchClient, Match } from "./content-search";
import { DEBOUNCE_MS, POLL_INTERVAL_MS } from "./content-search-state";
import { useContentSearch } from "./use-content-search";

function hit(line: number, path = "a.ts"): Match {
  return { path, line, column: 1, text: "foo", ranges: [{ start: 0, end: 3 }] };
}

/** What the daemon has found by the time of one poll, and whether rg has exited. */
interface Step {
  found: Match[];
  done: boolean;
}

interface Fake {
  client: ContentSearchClient;
  calls: string[];
}

// The fake keeps each search's matches the way the plugin's session does, and answers a poll with
// the matches after the cursor it is given, so a hook that polls from the wrong cursor duplicates.
function fakeClient(steps: Step[]): Fake {
  const calls: string[] = [];
  let started = 0;
  const found: Match[] = [];
  let done = false;
  const client: ContentSearchClient = {
    invokePluginRpc: async (_plugin, method, input) => {
      if (method === "irix.search.content.start") {
        started += 1;
        calls.push(`start:${(input as { query: string }).query}`);
        return { id: `s${started}` };
      }
      if (method === "irix.search.content.poll") {
        const { id, cursor } = input as { id: string; cursor: number };
        calls.push(`poll:${id}@${cursor}`);
        const step = steps.shift();
        if (step) {
          found.push(...step.found);
          done = step.done;
        } else {
          done = true;
        }
        return {
          batch: found.slice(cursor),
          cursor: found.length,
          done,
          truncated: false,
          error: null,
        };
      }
      calls.push(`cancel:${(input as { id: string }).id}`);
      return {};
    },
  };
  return { client, calls };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

function failingStart(error: Error): ContentSearchClient {
  return {
    invokePluginRpc: async () => {
      throw error;
    },
  };
}

// The shape DaemonClient rejects with when the daemon answers rpc_error (see
// packages/client/src/daemon-client.ts, DaemonRpcError, and session.ts "Request failed: ").
function daemonRpcError(message: string): Error {
  const error = new Error(
    `Request failed: ${message} requestType=plugin.rpc.invoke.request code=handler_error`,
  );
  error.name = "DaemonRpcError";
  return error;
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

  it("debounces, then polls from the last cursor every interval until done", async () => {
    const fake = fakeClient([
      { found: [hit(1)], done: false },
      { found: [hit(2), hit(3)], done: false },
      { found: [], done: true },
    ]);
    const { result } = renderHook(() =>
      useContentSearch({ client: fake.client, cwd: "/r", options: baseOptions }),
    );
    await advance(DEBOUNCE_MS - 1);
    expect(fake.calls).toEqual([]);
    await advance(1);
    expect(fake.calls).toEqual(["start:foo", "poll:s1@0"]);
    expect(result.current.status).toBe("searching");
    expect(result.current.matchCount).toBe(1);
    await advance(POLL_INTERVAL_MS - 1);
    expect(fake.calls).toEqual(["start:foo", "poll:s1@0"]);
    await advance(1);
    expect(fake.calls).toEqual(["start:foo", "poll:s1@0", "poll:s1@1"]);
    expect(result.current.matchCount).toBe(3);
    await advance(POLL_INTERVAL_MS);
    expect(fake.calls).toEqual(["start:foo", "poll:s1@0", "poll:s1@1", "poll:s1@3"]);
    expect(result.current.status).toBe("done");
    expect(result.current.matchCount).toBe(3);
    expect(result.current.groups[0]?.matches.map((match) => match.line)).toEqual([1, 2, 3]);
    await advance(POLL_INTERVAL_MS * 3);
    expect(fake.calls).toHaveLength(4);
  });

  it("cancels the running search when the query changes, before starting the next", async () => {
    const fake = fakeClient([{ found: [], done: false }]);
    const { rerender } = renderHook(
      ({ query }) =>
        useContentSearch({ client: fake.client, cwd: "/r", options: { ...baseOptions, query } }),
      { initialProps: { query: "foo" } },
    );
    await advance(DEBOUNCE_MS);
    expect(fake.calls).toEqual(["start:foo", "poll:s1@0"]);
    rerender({ query: "foob" });
    await advance(0);
    expect(fake.calls).toEqual(["start:foo", "poll:s1@0", "cancel:s1"]);
    await advance(DEBOUNCE_MS);
    expect(fake.calls[3]).toBe("start:foob");
  });

  it("drops a slow earlier search that answers after a newer query started", async () => {
    const slowStart = deferred<unknown>();
    const calls: string[] = [];
    const client: ContentSearchClient = {
      invokePluginRpc: async (_plugin, method, input) => {
        const record = input as { query?: string; id?: string; cursor?: number };
        if (method === "irix.search.content.start") {
          calls.push(`start:${record.query}`);
          if (record.query === "foo") return slowStart.promise;
          return { id: "fast" };
        }
        if (method === "irix.search.content.poll") {
          calls.push(`poll:${record.id}@${record.cursor}`);
          const line = record.id === "slow" ? 99 : 1;
          return {
            batch: [hit(line, `${record.id}.ts`)],
            cursor: 1,
            done: true,
            truncated: false,
            error: null,
          };
        }
        calls.push(`cancel:${record.id}`);
        return {};
      },
    };
    const { result, rerender } = renderHook(
      ({ query }) => useContentSearch({ client, cwd: "/r", options: { ...baseOptions, query } }),
      { initialProps: { query: "foo" } },
    );
    await advance(DEBOUNCE_MS);
    rerender({ query: "foob" });
    await advance(DEBOUNCE_MS);
    expect(result.current.status).toBe("done");
    expect(result.current.groups.map((group) => group.path)).toEqual(["fast.ts"]);

    slowStart.resolve({ id: "slow" });
    await advance(POLL_INTERVAL_MS * 3);
    expect(calls).toContain("cancel:slow");
    expect(calls).not.toContain("poll:slow@0");
    expect(result.current.groups.map((group) => group.path)).toEqual(["fast.ts"]);
    expect(result.current.matchCount).toBe(1);
  });

  it("shows a poll that fails mid-search as an error and stops polling", async () => {
    let polls = 0;
    const client: ContentSearchClient = {
      invokePluginRpc: async (_plugin, method) => {
        if (method === "irix.search.content.start") return { id: "s1" };
        if (method === "irix.search.content.poll") {
          polls += 1;
          if (polls === 2) throw daemonRpcError("Plugin RPC timed out: irix-content-search.invoke");
          return { batch: [hit(1)], cursor: 1, done: false, truncated: false, error: null };
        }
        return {};
      },
    };
    const { result } = renderHook(() =>
      useContentSearch({ client, cwd: "/r", options: baseOptions }),
    );
    await advance(DEBOUNCE_MS);
    expect(result.current.status).toBe("searching");
    await advance(POLL_INTERVAL_MS);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Plugin RPC timed out: irix-content-search.invoke");
    await advance(POLL_INTERVAL_MS * 3);
    expect(polls).toBe(2);
    expect(result.current.status).toBe("error");
  });

  it("cancels on unmount", async () => {
    const fake = fakeClient([{ found: [], done: false }]);
    const { unmount } = renderHook(() =>
      useContentSearch({ client: fake.client, cwd: "/r", options: baseOptions }),
    );
    await advance(DEBOUNCE_MS);
    unmount();
    await advance(POLL_INTERVAL_MS * 3);
    expect(fake.calls).toEqual(["start:foo", "poll:s1@0", "cancel:s1"]);
  });

  it.each([
    ["a missing plugin", "Plugin is not available: irix-content-search"],
    [
      "a plugin without the method",
      "Plugin irix-content-search does not contribute RPC irix.search.content.start",
    ],
    ["a plugin process without the method", "Unknown RPC method: irix.search.content.start"],
    ["a host with no plugin service", "Plugin service is unavailable"],
  ])("tells the user to update the host for %s", async (_label, message) => {
    const { result } = renderHook(() =>
      useContentSearch({
        client: failingStart(daemonRpcError(message)),
        cwd: "/r",
        options: baseOptions,
      }),
    );
    await advance(DEBOUNCE_MS);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Search is not available on this host. Update the host.");
  });

  it.each([
    [
      "a daemon-side timeout",
      daemonRpcError("Plugin RPC timed out: irix-content-search.invoke"),
      "Plugin RPC timed out: irix-content-search.invoke",
    ],
    ["the plugin's own error", daemonRpcError("Not a workspace folder"), "Not a workspace folder"],
    [
      "a client-side timeout",
      new Error("Timeout waiting for message (30000ms)"),
      "Timeout waiting for message (30000ms)",
    ],
  ])("shows %s as it is", async (_label, error, shown) => {
    const { result } = renderHook(() =>
      useContentSearch({ client: failingStart(error), cwd: "/r", options: baseOptions }),
    );
    await advance(DEBOUNCE_MS);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe(shown);
  });
});
