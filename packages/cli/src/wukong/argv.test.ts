import { describe, expect, it } from "vitest";

import { mendSplitQuotedArgs } from "./argv.js";

describe("mendSplitQuotedArgs", () => {
  it("joins a message that was cut at the spaces, and removes its quotes", () => {
    expect(mendSplitQuotedArgs(["send", "e0a7bd30", '"What', "are", "you", 'doing?"'])).toEqual([
      "send",
      "e0a7bd30",
      "What are you doing?",
    ]);
    expect(
      mendSplitQuotedArgs(["send", "e0a7", "'Hi!", "How", "are", "you?'", "--no-wait"]),
    ).toEqual(["send", "e0a7", "Hi! How are you?", "--no-wait"]);
  });

  it("keeps working when flags come before and after the message", () => {
    expect(
      mendSplitQuotedArgs([
        "run",
        "--provider",
        "claude",
        '"Reply',
        "with",
        'PONG"',
        "--title",
        "child",
      ]),
    ).toEqual(["run", "--provider", "claude", "Reply with PONG", "--title", "child"]);
  });

  it("leaves arguments that were parsed correctly exactly as they are", () => {
    for (const args of [
      ["send", "e0a7", "What are you doing?"],
      ["send", "e0a7", '"Hi!"'],
      ["send", "e0a7", "it's fine", "--no-wait"],
      ["agent", "ls"],
      [],
    ]) {
      expect(mendSplitQuotedArgs(args)).toEqual(args);
    }
  });

  it("does not touch an opening quote that never closes", () => {
    const args = ["send", "e0a7", '"What', "are", "you"];
    expect(mendSplitQuotedArgs(args)).toEqual(args);
  });
});
