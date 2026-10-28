import { describe, expect, it } from "vitest";
import { mapPreviewSelectionToSource } from "./markdown-source-map";

const doc = [
  "# Title", // 1
  "", // 2
  "The value is set here.", // 3
  "", // 4
  "Another paragraph mentions the value twice: value.", // 5
  "", // 6
  "- first item", // 7
  "- second item", // 8
  "", // 9
  "Some **bold** words and `code` too.", // 10
  "", // 11
  "```ts", // 12
  "const answer = 42;", // 13
  "return answer;", // 14
  "```", // 15
  "", // 16
  "| a | b |", // 17
  "| - | - |", // 18
  "| cell one | cell two |", // 19
].join("\n");

describe("mapPreviewSelectionToSource", () => {
  it("finds the lines of a selection inside one paragraph", () => {
    expect(
      mapPreviewSelectionToSource(doc, {
        selected: "is set here",
        before: "TitleThe value ",
        after: "Another paragraph",
      }),
    ).toEqual({ status: "ok", range: { startLine: 3, endLine: 3 } });
  });

  it("picks the occurrence whose surroundings match when a word repeats", () => {
    expect(
      mapPreviewSelectionToSource(doc, {
        selected: "value",
        before: "Another paragraph mentions the ",
        after: " twice: value.",
      }),
    ).toEqual({ status: "ok", range: { startLine: 5, endLine: 5 } });
    expect(
      mapPreviewSelectionToSource(doc, {
        selected: "value",
        before: "TitleThe ",
        after: " is set here.",
      }),
    ).toEqual({ status: "ok", range: { startLine: 3, endLine: 3 } });
  });

  it("matches text that the source writes with markup", () => {
    expect(
      mapPreviewSelectionToSource(doc, {
        selected: "bold words and code",
        before: "second itemSome ",
        after: " too.",
      }),
    ).toEqual({ status: "ok", range: { startLine: 10, endLine: 10 } });
  });

  it("covers every block a selection crosses", () => {
    expect(
      mapPreviewSelectionToSource(doc, {
        selected: "set here.\n\nAnother paragraph",
        before: "The value is ",
        after: " mentions the value",
      }),
    ).toEqual({ status: "ok", range: { startLine: 3, endLine: 5 } });
  });

  it("numbers lines inside a fenced code block from the line after the fence", () => {
    expect(
      mapPreviewSelectionToSource(doc, {
        selected: "return answer;",
        before: "const answer = 42;",
        after: "a b",
      }),
    ).toEqual({ status: "ok", range: { startLine: 14, endLine: 14 } });
  });

  it("numbers lines of an indented code block, which has no fence line", () => {
    const indented = [
      "Intro text.",
      "",
      "    let indentedOne = 1;",
      "    let indentedTwo = 2;",
    ].join("\n");
    expect(
      mapPreviewSelectionToSource(indented, {
        selected: "let indentedTwo = 2;",
        before: "let indentedOne = 1;",
        after: "",
      }),
    ).toEqual({ status: "ok", range: { startLine: 4, endLine: 4 } });
  });

  it("finds list items and table cells", () => {
    expect(
      mapPreviewSelectionToSource(doc, {
        selected: "second item",
        before: "first item",
        after: "Some",
      }),
    ).toEqual({ status: "ok", range: { startLine: 8, endLine: 8 } });
    expect(
      mapPreviewSelectionToSource(doc, { selected: "cell two", before: "a bcell one", after: "" }),
    ).toEqual({ status: "ok", range: { startLine: 19, endLine: 19 } });
  });

  it("counts the front matter's lines", () => {
    const withFrontMatter = ["---", "title: x", "---", "", "Hello there world."].join("\n");
    expect(
      mapPreviewSelectionToSource(withFrontMatter, {
        selected: "there world",
        before: "Hello ",
        after: ".",
      }),
    ).toEqual({ status: "ok", range: { startLine: 5, endLine: 5 } });
  });

  it("drops list markers the page shows but the source text lacks, at the ends of a selection", () => {
    expect(
      mapPreviewSelectionToSource(doc, {
        selected: "• first item\n• second item",
        before: "Another paragraph mentions the value twice: value.",
        after: "Some bold words",
      }),
    ).toEqual({ status: "ok", range: { startLine: 7, endLine: 8 } });
  });

  it("says so when the same passage appears twice with the same surroundings", () => {
    const repeated = "Same words here.\n\nSame words here.";
    expect(
      mapPreviewSelectionToSource(repeated, {
        selected: "Same words",
        before: "",
        after: " here.",
      }),
    ).toEqual({ status: "ambiguous" });
  });

  it("says so when the text is not in the source", () => {
    expect(
      mapPreviewSelectionToSource(doc, { selected: "nothing like this", before: "", after: "" }),
    ).toEqual({ status: "not-found" });
    expect(mapPreviewSelectionToSource(doc, { selected: "  \n ", before: "", after: "" })).toEqual({
      status: "not-found",
    });
  });
});
