import { describe, expect, it } from "vitest";

import {
  cancelSearch,
  pollSearch,
  startSearch,
  type ContentSearchClient,
  type SearchOptions,
} from "./content-search";

const options: SearchOptions = {
  cwd: "/repo",
  query: "foo",
  caseSensitive: false,
  regex: false,
  wholeWord: false,
  include: "",
  exclude: "",
};

function recordingClient(answer: unknown): { client: ContentSearchClient; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    client: {
      invokePluginRpc: async (...args) => {
        calls.push(args);
        return answer;
      },
    },
  };
}

describe("content search client", () => {
  it("starts a search and returns its id", async () => {
    const { client, calls } = recordingClient({ id: "s1" });
    expect(await startSearch(client, options)).toBe("s1");
    expect(calls).toEqual([["irix-content-search", "irix.search.content.start", options]]);
  });

  it("polls from a cursor and validates the batch", async () => {
    const answer = {
      batch: [{ path: "a.ts", line: 1, column: 2, text: "foo", ranges: [{ start: 0, end: 3 }] }],
      cursor: 1,
      done: false,
      truncated: false,
      error: null,
    };
    const { client, calls } = recordingClient(answer);
    expect(await pollSearch(client, "s1", 0)).toEqual(answer);
    expect(calls).toEqual([
      ["irix-content-search", "irix.search.content.poll", { id: "s1", cursor: 0 }],
    ]);
  });

  it("rejects an answer of the wrong shape", async () => {
    const { client } = recordingClient({ batch: "nope" });
    await expect(pollSearch(client, "s1", 0)).rejects.toThrow();
    await expect(startSearch(recordingClient({}).client, options)).rejects.toThrow();
  });

  it("cancels by id", async () => {
    const { client, calls } = recordingClient({});
    await cancelSearch(client, "s1");
    expect(calls).toEqual([["irix-content-search", "irix.search.content.cancel", { id: "s1" }]]);
  });
});
