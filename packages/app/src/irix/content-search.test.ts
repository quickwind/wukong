import { describe, expect, it } from "vitest";

import { pollSearchRpc, startSearchRpc } from "../../../../plugins/irix-content-search/shared/rpc";

import {
  cancelSearch,
  pollSearch,
  startSearch,
  type ContentSearchClient,
  type SearchOptions,
} from "./content-search";
import { shouldSearch } from "./content-search-state";

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

// content-search.ts copies the plugin's schemas because the app cannot import the plugin bundle;
// the test can, so a change on one side that the other does not make fails here.
describe("content search schemas match the plugin's", () => {
  const match = { path: "a.ts", line: 3, column: 2, text: "foo", ranges: [{ start: 1, end: 4 }] };
  const answer = { batch: [match], cursor: 1, done: false, truncated: false, error: null };
  const { column: _column, ...matchWithoutColumn } = match;

  async function appAccepts(poll: unknown): Promise<boolean> {
    return pollSearch(recordingClient(poll).client, "s1", 0).then(
      () => true,
      () => false,
    );
  }

  it.each([
    ["a valid match", answer, true],
    ["a match with a missing field", { ...answer, batch: [matchWithoutColumn] }, false],
    ["a match on line 0", { ...answer, batch: [{ ...match, line: 0 }] }, false],
    ["a finished poll with an error", { ...answer, done: true, error: "ripgrep failed" }, true],
    ["an error that is not a string", { ...answer, error: 2 }, false],
  ])("both sides agree on %s", async (_label, poll, accepted) => {
    expect(pollSearchRpc.output.safeParse(poll).success).toBe(accepted);
    expect(await appAccepts(poll)).toBe(accepted);
  });

  it.each([
    ["f", false],
    ["fo", true],
  ])("both sides agree whether %j is long enough to search", (query, accepted) => {
    expect(startSearchRpc.input.safeParse({ ...options, query }).success).toBe(accepted);
    expect(shouldSearch(query)).toBe(accepted);
  });

  it("starts with the answer the plugin gives", async () => {
    const started = { id: "s1" };
    expect(startSearchRpc.output.safeParse(started).success).toBe(true);
    expect(await startSearch(recordingClient(started).client, options)).toBe("s1");
  });
});
