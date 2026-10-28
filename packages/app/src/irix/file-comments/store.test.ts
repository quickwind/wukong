import { beforeEach, describe, expect, it } from "vitest";
import {
  addFileComment,
  clearSentFileComments,
  deleteFileComment,
  getFileComments,
  resetFileCommentStore,
  updateFileComment,
} from "./store";

const input = {
  filePath: "src/a.ts",
  startLine: 3,
  endLine: 4,
  lineText: "x\ny",
  selectedText: null,
  body: "why?",
};

describe("file comment store", () => {
  beforeEach(() => resetFileCommentStore());

  it("keeps a new comment under its key with an id and times", () => {
    const added = addFileComment({ key: "s:w", comment: input });
    expect(added.id).not.toBe("");
    expect(added.createdAt).toBe(added.updatedAt);
    expect(getFileComments("s:w")).toEqual([added]);
    expect(getFileComments("other")).toEqual([]);
  });

  it("edits and deletes a comment", () => {
    const added = addFileComment({ key: "s:w", comment: input });
    updateFileComment({ key: "s:w", id: added.id, body: "changed" });
    expect(getFileComments("s:w")[0].body).toBe("changed");
    deleteFileComment({ key: "s:w", id: added.id });
    expect(getFileComments("s:w")).toEqual([]);
  });

  it("clears only the comments that were sent", () => {
    const sent = addFileComment({ key: "s:w", comment: input });
    const later = addFileComment({
      key: "s:w",
      comment: { ...input, body: "added while sending" },
    });
    clearSentFileComments({ key: "s:w", comments: [sent] });
    expect(getFileComments("s:w")).toEqual([later]);
  });

  it("keeps a huge selection from filling the browser's storage", () => {
    const huge = "x".repeat(3_000_000);
    const added = addFileComment({
      key: "s:w",
      comment: { ...input, lineText: huge, selectedText: huge },
    });
    expect(added.lineText.length).toBeLessThanOrEqual(20_000);
    expect(added.selectedText?.length).toBeLessThanOrEqual(20_000);
    expect(getFileComments("s:w")[0].lineText.length).toBeLessThanOrEqual(20_000);
  });

  it("resets to empty", () => {
    addFileComment({ key: "s:w", comment: input });
    resetFileCommentStore();
    expect(getFileComments("s:w")).toEqual([]);
  });
});
