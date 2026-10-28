import { describe, expect, it } from "vitest";
import { FILE_COMMENT_ATTACHMENT_TITLE, formatFileCommentsAttachment } from "./format";
import type { FileComment } from "./model";

function comment(overrides: Partial<FileComment> = {}): FileComment {
  return {
    id: "a",
    filePath: "src/a.ts",
    startLine: 12,
    endLine: 12,
    lineText: "const x = 1;",
    selectedText: null,
    body: "Why 1?",
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

const none = new Set<string>();
const checked = { uncheckedIds: none };

describe("formatFileCommentsAttachment", () => {
  it("returns null without comments", () => {
    expect(
      formatFileCommentsAttachment({
        comments: [],
        modifiedPaths: none,
        driftedIds: none,
        ...checked,
      }),
    ).toBeNull();
  });

  it("writes a one-line comment", () => {
    const attachment = formatFileCommentsAttachment({
      comments: [comment()],
      modifiedPaths: none,
      driftedIds: none,
      ...checked,
    });
    expect(attachment).toEqual({
      type: "text",
      mimeType: "text/plain",
      title: FILE_COMMENT_ATTACHMENT_TITLE,
      text: [
        "Paseo file comment attachment",
        "",
        "Comment 1: src/a.ts:12",
        "Commented lines:",
        "> const x = 1;",
        "Why 1?",
      ].join("\n"),
    });
  });

  it("writes a line range and the selected words", () => {
    const attachment = formatFileCommentsAttachment({
      comments: [
        comment({
          startLine: 12,
          endLine: 13,
          lineText: "foo(bar);\nbaz();",
          selectedText: "bar",
        }),
      ],
      modifiedPaths: none,
      driftedIds: none,
      ...checked,
    });
    expect(attachment?.text).toBe(
      [
        "Paseo file comment attachment",
        "",
        "Comment 1: src/a.ts:12-13",
        "Selected text: bar",
        "Commented lines:",
        "> foo(bar);",
        "> baz();",
        "Why 1?",
      ].join("\n"),
    );
  });

  it("separates comments with a blank line and numbers them", () => {
    const text = formatFileCommentsAttachment({
      comments: [comment({ id: "a" }), comment({ id: "b", body: "second" })],
      modifiedPaths: none,
      driftedIds: none,
      ...checked,
    })?.text;
    expect(text).toContain("Why 1?\n\nComment 2: src/a.ts:12");
  });

  it("says when the file has unsaved changes", () => {
    const text = formatFileCommentsAttachment({
      comments: [comment()],
      modifiedPaths: new Set(["src/a.ts"]),
      driftedIds: none,
      ...checked,
    })?.text;
    expect(text).toContain(
      "Note: the file has unsaved changes; line numbers refer to the editor content, not the file on disk.",
    );
  });

  it("says when the file changed since the comment", () => {
    const text = formatFileCommentsAttachment({
      comments: [comment()],
      modifiedPaths: none,
      driftedIds: new Set(["a"]),
      ...checked,
    })?.text;
    expect(text).toContain(
      "Note: the file changed since this comment was written; the line numbers may be off, the commented text below is what the user saw.",
    );
  });

  it("says when the file was not open to check the line numbers against", () => {
    const text = formatFileCommentsAttachment({
      comments: [comment()],
      modifiedPaths: none,
      driftedIds: none,
      uncheckedIds: new Set(["a"]),
    })?.text;
    expect(text).toContain(
      "Note: the file was not open when this was sent, so the line numbers were not checked against it; the commented text below is what the user saw.",
    );
  });

  it("adds no note when nothing changed", () => {
    const text = formatFileCommentsAttachment({
      comments: [comment()],
      modifiedPaths: none,
      driftedIds: none,
      ...checked,
    })?.text;
    expect(text).not.toContain("Note:");
  });

  it("marks text it cut short", () => {
    const lineText = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");
    const text = formatFileCommentsAttachment({
      comments: [comment({ startLine: 1, endLine: 80, lineText })],
      modifiedPaths: none,
      driftedIds: none,
      ...checked,
    })?.text;
    expect(text).toContain("> line 50\n[truncated]");
    expect(text).not.toContain("line 51");
  });
});
