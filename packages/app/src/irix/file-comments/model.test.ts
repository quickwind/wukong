import { describe, expect, it } from "vitest";
import {
  addComment,
  capText,
  clearComments,
  deleteComment,
  FileCommentStateSchema,
  lineRangeFromSelection,
  shouldReplaceDraft,
  updateComment,
  type FileComment,
  type FileCommentState,
} from "./model";

// Three lines: "aaa\n" (0-3), "bbb\n" (4-7), "ccc" (8-11).
const doc = {
  lineAt(pos: number) {
    if (pos < 4) return { number: 1, from: 0 };
    if (pos < 8) return { number: 2, from: 4 };
    return { number: 3, from: 8 };
  },
};

function comment(id: string, overrides: Partial<FileComment> = {}): FileComment {
  return {
    id,
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 1,
    lineText: "aaa",
    selectedText: null,
    body: "why?",
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

const empty: FileCommentState = { drafts: {} };

describe("lineRangeFromSelection", () => {
  it("covers one line when the selection stays inside it", () => {
    expect(lineRangeFromSelection(doc, 5, 7)).toEqual({ startLine: 2, endLine: 2 });
  });

  it("covers every line a selection crosses", () => {
    expect(lineRangeFromSelection(doc, 1, 9)).toEqual({ startLine: 1, endLine: 3 });
  });

  it("stops at the previous line when the selection ends at the start of the next one", () => {
    expect(lineRangeFromSelection(doc, 0, 4)).toEqual({ startLine: 1, endLine: 1 });
  });

  it("takes the caret's line for a collapsed selection", () => {
    expect(lineRangeFromSelection(doc, 5, 5)).toEqual({ startLine: 2, endLine: 2 });
  });
});

describe("draft state", () => {
  it("returns the same state when updating a comment that does not exist", () => {
    const state = addComment(empty, { key: "k", comment: comment("a") });
    expect(updateComment(state, { key: "k", id: "zzz", body: "x", updatedAt: "t" })).toBe(state);
  });

  it("updates the body and the update time of the matching comment", () => {
    const state = addComment(empty, { key: "k", comment: comment("a") });
    const next = updateComment(state, {
      key: "k",
      id: "a",
      body: "changed",
      updatedAt: "2026-10-28T01:00:00.000Z",
    });
    expect(next.drafts.k[0]).toMatchObject({
      body: "changed",
      updatedAt: "2026-10-28T01:00:00.000Z",
    });
  });

  it("drops the key once its last comment is deleted", () => {
    const state = addComment(empty, { key: "k", comment: comment("a") });
    expect(deleteComment(state, { key: "k", id: "a" }).drafts).toEqual({});
  });

  it("clears only the given ids and keeps comments added since", () => {
    let state = addComment(empty, { key: "k", comment: comment("a") });
    state = addComment(state, { key: "k", comment: comment("b") });
    expect(clearComments(state, { key: "k", ids: ["a"] }).drafts.k.map((c) => c.id)).toEqual(["b"]);
    expect(clearComments(state, { key: "k", ids: ["a", "b"] }).drafts).toEqual({});
  });
});

describe("shouldReplaceDraft", () => {
  it("replaces nothing, an empty draft, and a draft with only spaces", () => {
    expect(shouldReplaceDraft(null)).toBe(true);
    expect(shouldReplaceDraft({ body: "" })).toBe(true);
    expect(shouldReplaceDraft({ body: "  \n" })).toBe(true);
  });

  it("keeps a draft the user has written text into", () => {
    expect(shouldReplaceDraft({ body: "half a thought" })).toBe(false);
  });
});

describe("capText", () => {
  it("keeps text inside both limits", () => {
    expect(capText("a\nb", { maxLines: 2, maxChars: 100 })).toEqual({
      text: "a\nb",
      truncated: false,
    });
  });

  it("cuts lines past the limit", () => {
    expect(capText("a\nb\nc", { maxLines: 2, maxChars: 100 })).toEqual({
      text: "a\nb",
      truncated: true,
    });
  });

  it("cuts characters past the limit", () => {
    expect(capText("abcdef", { maxLines: 5, maxChars: 3 })).toEqual({
      text: "abc",
      truncated: true,
    });
  });
});

describe("FileCommentStateSchema", () => {
  it("rejects a comment without the text of its lines", () => {
    const { lineText: _lineText, ...withoutLineText } = comment("a");
    expect(FileCommentStateSchema.safeParse({ drafts: { k: [withoutLineText] } }).success).toBe(
      false,
    );
  });

  it("accepts a stored comment", () => {
    expect(FileCommentStateSchema.safeParse({ drafts: { k: [comment("a")] } }).success).toBe(true);
  });
});
