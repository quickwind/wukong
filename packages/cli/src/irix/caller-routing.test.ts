import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { beforeAll, describe, expect, it } from "vitest";
import { installCallerRouting } from "./caller-routing.js";

interface Params {
  message: { type: string } & Record<string, unknown>;
  timeout?: number;
}

type Send = (this: unknown, params: Params) => Promise<unknown>;

const sent: Params[] = [];
const env: NodeJS.ProcessEnv = {};
const prototype = DaemonClient.prototype as unknown as { sendCorrelatedSessionRequest: Send };

beforeAll(() => {
  prototype.sendCorrelatedSessionRequest = async (params) => {
    sent.push(params);
  };
  installCallerRouting(env);
});

function fakeClient(options: { required: boolean; known: string[] }) {
  let lookups = 0;
  const client = {
    lastServerInfoMessage: { features: { requireSubagentApproval: options.required } },
    fetchAgent: async ({ agentId }: { agentId: string }) => {
      lookups += 1;
      return options.known.includes(agentId) ? { agent: { id: agentId } } : null;
    },
  };
  const send = (message: Params["message"]) =>
    prototype.sendCorrelatedSessionRequest.call(client, { message });
  return { send, lookups: () => lookups };
}

describe("caller routing", () => {
  it("names a known calling agent on schedule requests, once per connection, with no deadline", async () => {
    sent.length = 0;
    env.PASEO_AGENT_ID = " agent-1 ";
    const { send, lookups } = fakeClient({ required: true, known: ["agent-1"] });
    for (const type of [
      "schedule/create",
      "schedule/resume",
      "schedule/run-once",
      "schedule/update",
    ]) {
      await send({ type });
    }
    await send({ type: "schedule/list" });

    expect(sent.map((params) => params.message.callerAgentId)).toEqual([
      "agent-1",
      "agent-1",
      "agent-1",
      "agent-1",
      undefined,
    ]);
    expect(sent.map((params) => params.timeout)).toEqual([0, 0, 0, 0, undefined]);
    expect(lookups()).toBe(1);
  });

  it("refuses, without sending, what an unknown caller asks while approval is required", async () => {
    sent.length = 0;
    env.PASEO_AGENT_ID = "stale";
    const { send } = fakeClient({ required: true, known: [] });
    await expect(send({ type: "schedule/run-once" })).rejects.toMatchObject({
      code: "SUBAGENT_APPROVAL_UNAVAILABLE",
    });
    await expect(send({ type: "agent.create.request" })).rejects.toMatchObject({
      code: "SUBAGENT_APPROVAL_UNAVAILABLE",
    });
    await expect(
      send({ type: "workspace.create.request", agent: { initialPrompt: "x" } }),
    ).rejects.toMatchObject({ code: "SUBAGENT_APPROVAL_UNAVAILABLE" });
    expect(sent).toEqual([]);
  });

  it("passes through a creation that names its caller, a bare workspace, and everything when approval is off", async () => {
    sent.length = 0;
    env.PASEO_AGENT_ID = "agent-1";
    const required = fakeClient({ required: true, known: ["agent-1"] });
    await required.send({ type: "agent.create.request", callerAgentId: "agent-1" });
    await required.send({ type: "workspace.create.request" });
    const off = fakeClient({ required: false, known: [] });
    await off.send({ type: "agent.create.request" });
    await off.send({ type: "schedule/create" });
    expect(sent.map((params) => params.message.type)).toEqual([
      "agent.create.request",
      "workspace.create.request",
      "agent.create.request",
      "schedule/create",
    ]);
  });

  it("changes nothing outside an agent's shell", async () => {
    sent.length = 0;
    delete env.PASEO_AGENT_ID;
    const { send } = fakeClient({ required: true, known: [] });
    await send({ type: "agent.create.request" });
    await send({ type: "schedule/create" });
    expect(sent.map((params) => params.message.callerAgentId)).toEqual([undefined, undefined]);
  });
});
