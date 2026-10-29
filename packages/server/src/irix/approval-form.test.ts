import { describe, expect, it } from "vitest";

import {
  describeSubagentRequest,
  formatApprovalForm,
  previewForApproval,
} from "./approval-form.js";

describe("approval form text", () => {
  it("writes label and value lines, leaves out empty values and indents a long value's later lines", () => {
    expect(
      formatApprovalForm([
        ["Provider", "claude"],
        ["Model", "claude-haiku-5-5"],
        ["Mode", undefined],
        ["Title", null],
        ["Thinking", ""],
        ["Prompt", "first line\nsecond line"],
      ]),
    ).toBe(
      ["Provider: claude", "Model: claude-haiku-5-5", "Prompt: first line", "    second line"].join(
        "\n",
      ),
    );
  });

  it("shortens only a long prompt", () => {
    expect(previewForApproval("short")).toBe("short");
    expect(previewForApproval("x".repeat(600))).toBe(`${"x".repeat(500)}...`);
    expect(previewForApproval(undefined)).toBe("");
  });

  it("shows the model the agent chose for its subagent, or says none was set", () => {
    const input = {
      subagent_type: "general-purpose",
      description: "PONG",
      prompt: "Reply PONG",
      run_in_background: true,
    };
    expect(describeSubagentRequest({ ...input, model: "sonnet" }, "claude-haiku-5-5")).toBe(
      [
        "Subagent: general-purpose",
        "Model: sonnet",
        "Description: PONG",
        "Background: true",
        "Prompt: Reply PONG",
      ].join("\n"),
    );
    expect(describeSubagentRequest(input, "claude-haiku-5-5")).toContain(
      "Model: not set: the subagent type's default, normally this agent's (claude-haiku-5-5)",
    );
    expect(describeSubagentRequest(input, undefined)).toContain("normally this agent's");
  });
});
