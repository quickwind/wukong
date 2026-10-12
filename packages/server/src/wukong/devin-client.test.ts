import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentSession } from "../server/agent/agent-sdk-types.js";
import { activateWukongPolicy } from "./policy.js";
import {
  createWukongAcpClient,
  DEVIN_COMMANDS_WAIT_MS,
  DevinACPAgentClient,
  hideInjectedInstructions,
  injectInstructionsIntoFirstPrompt,
  instructionBlock,
  paseoCommandLineGuide,
  withoutInjectedInstructions,
} from "./devin-client.js";

function sessionWithConnection() {
  const calls: unknown[] = [];
  const prompt = vi.fn(async (params: unknown) => {
    calls.push(params);
    return { stopReason: "end_turn" };
  });
  const session = { connection: { prompt } } as unknown as AgentSession;
  return {
    session,
    calls,
    prompt,
    connection: (session as unknown as { connection: { prompt: unknown } }).connection,
  };
}

const userBlocks = (text: string) => [{ type: "text", text }];

describe("Devin system prompt delivery", () => {
  it("puts the instructions ahead of the first message, as a block of their own", async () => {
    const { session, calls, connection } = sessionWithConnection();
    injectInstructionsIntoFirstPrompt(session, "Your name is Zorblax.");
    await (connection.prompt as (p: unknown) => Promise<unknown>)({
      sessionId: "s1",
      messageId: "m1",
      prompt: userBlocks("hello"),
    });
    const sent = calls[0] as {
      sessionId: string;
      messageId: string;
      prompt: Array<{ text: string }>;
    };
    expect(sent.sessionId).toBe("s1");
    expect(sent.messageId).toBe("m1");
    expect(sent.prompt).toHaveLength(2);
    expect(sent.prompt[0]).toEqual(instructionBlock("Your name is Zorblax."));
    expect(sent.prompt[0]?.text).toContain("Your name is Zorblax.");
    expect(sent.prompt[1]).toEqual({ type: "text", text: "hello" });
  });

  it("sends the instructions once: later messages go through untouched", async () => {
    const { session, calls, connection } = sessionWithConnection();
    injectInstructionsIntoFirstPrompt(session, "Be brief.");
    const send = connection.prompt as (p: unknown) => Promise<unknown>;
    await send({ sessionId: "s", prompt: userBlocks("one") });
    await send({ sessionId: "s", prompt: userBlocks("two") });
    expect((calls[0] as { prompt: unknown[] }).prompt).toHaveLength(2);
    expect(calls[1]).toEqual({ sessionId: "s", prompt: userBlocks("two") });
  });

  it("changes nothing without a system prompt", async () => {
    for (const systemPrompt of [undefined, "", "   \n"]) {
      const { session, calls, prompt, connection } = sessionWithConnection();
      injectInstructionsIntoFirstPrompt(session, systemPrompt);
      expect(connection.prompt).toBe(prompt);
      await (connection.prompt as (p: unknown) => Promise<unknown>)({
        prompt: userBlocks("hi"),
      });
      expect(calls[0]).toEqual({ prompt: userBlocks("hi") });
    }
  });

  it("warns, and does not throw, when the session has no connection to wrap", () => {
    const warn = vi.fn();
    expect(() =>
      injectInstructionsIntoFirstPrompt({} as AgentSession, "x", { warn }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("is chosen for the devin provider, in a Wukong edition only", () => {
    const options = {
      logger: pino({ level: "silent" }),
      command: ["devin", "acp"],
      providerId: "devin",
    } as never;
    expect(createWukongAcpClient("devin", options)).toBeUndefined();
    const deactivate = activateWukongPolicy();
    try {
      const client = createWukongAcpClient("devin", options);
      expect(client).toBeInstanceOf(DevinACPAgentClient);
      // Longer than upstream's 1.5 s, and a configured value would still win.
      expect(DEVIN_COMMANDS_WAIT_MS).toBeGreaterThan(1_500);
      expect(
        (client as unknown as { initialCommandsWaitTimeoutMs: number })
          .initialCommandsWaitTimeoutMs,
      ).toBe(DEVIN_COMMANDS_WAIT_MS);
      expect(createWukongAcpClient("cursor", options)).toBeUndefined();
    } finally {
      deactivate();
    }
  });

  describe("the replay after a resume", () => {
    it("cuts our block out of the first user message and keeps what was typed", () => {
      const block = instructionBlock("Your name is Zorblax.\nBe brief.").text;
      expect(withoutInjectedInstructions(`${block}What is your name?`)).toBe("What is your name?");
      expect(withoutInjectedInstructions(`${block}\nline one\nline two`)).toBe(
        "\nline one\nline two",
      );
    });

    it("leaves every other message alone, including one that merely mentions the tag", () => {
      for (const text of [
        "hello",
        "use <system-instructions> in your prompt",
        "<system-instructions>\nmy own block</system-instructions>question",
      ]) {
        expect(withoutInjectedInstructions(text)).toBe(text);
      }
    });

    it("filters the history stream: user messages only, other events untouched", async () => {
      const block = instructionBlock("Secret.").text;
      const events = [
        {
          type: "timeline",
          provider: "devin",
          item: { type: "user_message", text: `${block}hi`, messageId: "m1" },
        },
        {
          type: "timeline",
          provider: "devin",
          item: { type: "assistant_message", text: `${block}echo` },
        },
        { type: "turn_started", provider: "devin", turnId: "t1" },
      ];
      const session = {
        streamHistory: async function* () {
          yield* events;
        },
      } as unknown as AgentSession;
      hideInjectedInstructions(session);
      const out: unknown[] = [];
      for await (const event of session.streamHistory()) out.push(event);
      expect(out).toEqual([
        {
          type: "timeline",
          provider: "devin",
          item: { type: "user_message", text: "hi", messageId: "m1" },
        },
        events[1],
        events[2],
      ]);
    });
  });

  describe("Paseo's tools from the shell", () => {
    it("names the wukong commands and the agent's own ID", () => {
      const guide = paseoCommandLineGuide("a1b2c3d4-0000");
      for (const command of [
        "wukong agent ls",
        "wukong send",
        "wukong logs",
        "wukong wait",
        "wukong run",
      ]) {
        expect(guide).toContain(command);
      }
      expect(guide).toContain("--prompt-file");
      expect(guide).toContain("system temp folder");
      expect(guide).not.toContain("--prompt-file <file>");
      expect(guide).toContain("a1b2c3d4-0000");
      expect(guide).toContain("PASEO_AGENT_ID");
      expect(guide).toContain("create_agent");
      expect(guide).toContain("never `paseo`");
      expect(guide).toContain("report back");
    });

    it("still reads well when the agent's ID is not known yet", () => {
      const guide = paseoCommandLineGuide();
      expect(guide).toContain("wukong send");
      expect(guide).not.toContain("Your own agent ID");
    });

    it("rides in the first prompt together with the system prompt", async () => {
      const { session, calls, connection } = sessionWithConnection();
      injectInstructionsIntoFirstPrompt(
        session,
        ["Your name is Zorblax.", paseoCommandLineGuide("abc")].join("\n\n"),
      );
      await (connection.prompt as (p: unknown) => Promise<unknown>)({
        prompt: userBlocks("hi"),
      });
      const text = (calls[0] as { prompt: Array<{ text: string }> }).prompt[0]?.text ?? "";
      expect(text).toContain("Your name is Zorblax.");
      expect(text).toContain("wukong send");
    });
  });
});
