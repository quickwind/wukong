import { beforeEach, describe, expect, it } from "vitest";
import { addFileComment, getFileComments, resetFileCommentStore } from "./store";
import { registerOpenFile, takeFileCommentsForSend } from "./send";
import type { ComposerAttachment } from "@/attachments/types";

// The composer API takes composer attachments; a chat_history one passes its text through as is.
function textOf(attachment: ComposerAttachment): string {
  if (attachment.kind !== "chat_history") throw new Error(`unexpected ${attachment.kind}`);
  return attachment.attachment.text;
}

const scope = { serverId: "s", workspaceId: "w" };
const comment = {
  filePath: "src/a.ts",
  startLine: 2,
  endLine: 2,
  lineText: "const x = 1;",
  selectedText: null,
  body: "why?",
};

function openFile(lines: string[], modified = false) {
  return registerOpenFile({
    ...scope,
    filePath: "src/a.ts",
    read: () => ({
      lines: (start, end) => lines.slice(start - 1, end).join("\n"),
      modified,
    }),
  });
}

describe("takeFileCommentsForSend", () => {
  beforeEach(() => resetFileCommentStore());

  it("has nothing to send without comments", () => {
    const taken = takeFileCommentsForSend(scope.serverId, scope.workspaceId);
    expect(taken.attachments).toEqual([]);
    expect(() => taken.clearSent()).not.toThrow();
  });

  it("sends the comments of a file that is not open, saying it was not checked", () => {
    addFileComment({ key: "s:w", comment });
    const [attachment] = takeFileCommentsForSend(scope.serverId, scope.workspaceId).attachments;
    expect(attachment).toMatchObject({
      kind: "chat_history",
      attachment: { type: "text", title: "Paseo file comment attachment" },
    });
    expect(textOf(attachment)).toMatch(/^Paseo file comment attachment\n/);
    expect(textOf(attachment)).toContain("the file was not open when this was sent");
  });

  it("notes a drift when the lines of an open file no longer match", () => {
    addFileComment({ key: "s:w", comment });
    const close = openFile(["a", "const y = 2;", "c"]);
    const [attachment] = takeFileCommentsForSend(scope.serverId, scope.workspaceId).attachments;
    close();
    expect(textOf(attachment)).toContain("the file changed since");
  });

  it("adds no note when the lines of an open file still match", () => {
    addFileComment({ key: "s:w", comment });
    const close = openFile(["a", "const x = 1;", "c"]);
    const [attachment] = takeFileCommentsForSend(scope.serverId, scope.workspaceId).attachments;
    close();
    expect(textOf(attachment)).not.toContain("Note:");
  });

  it("notes unsaved changes of an open file", () => {
    addFileComment({ key: "s:w", comment });
    const close = openFile(["a", "const x = 1;", "c"], true);
    const [attachment] = takeFileCommentsForSend(scope.serverId, scope.workspaceId).attachments;
    close();
    expect(textOf(attachment)).toContain("unsaved changes");
  });

  it("treats a file that was closed as not open", () => {
    addFileComment({ key: "s:w", comment });
    openFile(["x", "y", "z"])();
    const [attachment] = takeFileCommentsForSend(scope.serverId, scope.workspaceId).attachments;
    expect(textOf(attachment)).toContain("the file was not open when this was sent");
    expect(textOf(attachment)).not.toContain("the file changed since");
  });

  it("clears what was sent and keeps comments added afterwards", () => {
    addFileComment({ key: "s:w", comment });
    const taken = takeFileCommentsForSend(scope.serverId, scope.workspaceId);
    const later = addFileComment({ key: "s:w", comment: { ...comment, body: "later" } });
    taken.clearSent();
    expect(getFileComments("s:w")).toEqual([later]);
  });
});
