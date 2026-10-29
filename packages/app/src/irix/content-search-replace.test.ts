import { describe, expect, it } from "vitest";
import type { Match } from "./content-search";
import {
  describeReplace,
  matchKey,
  planReplace,
  previewSegments,
  summarizeReplace,
} from "./content-search-replace";

function match(path: string, line: number, version = true): Match {
  return {
    path,
    line,
    column: 1,
    text: "foo",
    ranges: [{ start: 0, end: 3 }],
    ...(version ? { mtimeMs: 10, size: 5 } : {}),
  };
}

const groups = [
  { path: "a.ts", matches: [match("a.ts", 1), match("a.ts", 4)] },
  { path: "b.ts", matches: [match("b.ts", 2)] },
];

describe("planReplace", () => {
  it("takes every shown line with the file's version", () => {
    const plan = planReplace(groups, new Set(), new Set());
    expect(plan.files).toEqual([
      { path: "a.ts", mtimeMs: 10, size: 5, lines: [1, 4] },
      { path: "b.ts", mtimeMs: 10, size: 5, lines: [2] },
    ]);
    expect(plan.matchCount).toBe(3);
  });

  it("leaves out excluded lines and files, and drops a file with nothing left", () => {
    const plan = planReplace(groups, new Set([matchKey(match("a.ts", 1)), "b.ts:2"]), new Set());
    expect(plan.files.map((f) => [f.path, f.lines])).toEqual([["a.ts", [4]]]);
    expect(planReplace(groups, new Set(), new Set(["a.ts"])).files.map((f) => f.path)).toEqual([
      "b.ts",
    ]);
  });

  it("names files whose version is unknown instead of sending them", () => {
    const plan = planReplace(
      [{ path: "c.ts", matches: [match("c.ts", 1, false)] }],
      new Set(),
      new Set(),
    );
    expect(plan.files).toEqual([]);
    expect(plan.unversioned).toEqual(["c.ts"]);
  });
});

describe("summarizeReplace", () => {
  it("counts replaced matches and lists the files left alone", () => {
    const summary = summarizeReplace([
      { path: "a.ts", status: "replaced", count: 2, reason: null },
      { path: "b.ts", status: "skipped", count: 0, reason: "Changed on disk since the search" },
    ]);
    expect(summary).toEqual({
      replacedMatches: 2,
      replacedFiles: 1,
      skipped: [{ path: "b.ts", reason: "Changed on disk since the search" }],
    });
    expect(describeReplace(summary)).toBe("Replaced 2 matches in 1 file. 1 file left alone.");
  });
});

const view = (segments: ReturnType<typeof previewSegments>) =>
  segments.map(({ kind, text }) => ({ kind, text }));

describe("previewSegments", () => {
  it("strikes each match and puts the replacement after it", () => {
    expect(
      view(
        previewSegments(
          "a foo b foo",
          [
            { start: 2, end: 5 },
            { start: 8, end: 11 },
          ],
          "X",
        ),
      ),
    ).toEqual([
      { kind: "keep", text: "a " },
      { kind: "old", text: "foo" },
      { kind: "new", text: "X" },
      { kind: "keep", text: " b " },
      { kind: "old", text: "foo" },
      { kind: "new", text: "X" },
    ]);
  });

  it("shows only the struck match when the replacement is empty", () => {
    expect(view(previewSegments("foo", [{ start: 0, end: 3 }], ""))).toEqual([
      { kind: "old", text: "foo" },
    ]);
  });
});
