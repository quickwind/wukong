import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyIrixSurface } from "./surface.js";

// The Irix command tree is built on a real commander program with the upstream names it
// removes or keeps. applyIrixSurface reads process.env, so each test sets the switches it needs.
const SWITCHES = [
  "IRIX_UNRESTRICTED",
  "IRIX_ALLOW_SCHEDULES",
  "IRIX_ALLOW_AGENT_MESSAGING",
  "IRIX_ENABLE_CONNECTED_HOSTS",
  "PASEO_AGENT_ID",
];

function upstreamProgram(): Command {
  const program = new Command().name("paseo");
  for (const name of [
    "run",
    "ls",
    "send",
    "logs",
    "wait",
    "schedule",
    "heartbeat",
    "host",
    "clone",
    "onboard",
    "pair",
    "hub",
    "speech",
    "daemon",
    "agent",
  ]) {
    program.command(name);
  }
  program.commands.find((c) => c.name() === "daemon")!.command("pair");
  program.commands.find((c) => c.name() === "daemon")!.command("start");
  const agent = program.commands.find((c) => c.name() === "agent")!;
  agent.command("send");
  agent.command("ls");
  agent.command("run");
  return program;
}

function names(command: Command): string[] {
  return command.commands.map((c) => c.name());
}

function agentNames(program: Command): string[] {
  const agent = program.commands.find((c) => c.name() === "agent");
  return agent ? names(agent) : [];
}

function surface(): Command {
  return applyIrixSurface(upstreamProgram());
}

describe("Irix command surface", () => {
  beforeEach(() => {
    for (const name of SWITCHES) vi.stubEnv(name, "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names the program irix", () => {
    expect(surface().name()).toBe("irix");
  });

  it("removes the commands Irix does not use", () => {
    const program = surface();
    for (const name of ["clone", "onboard", "pair", "hub", "speech", "host"]) {
      expect(names(program)).not.toContain(name);
    }
    expect(names(program)).toEqual(expect.arrayContaining(["run", "ls", "logs", "wait", "daemon"]));
  });

  it("removes daemon pair but keeps the other daemon commands", () => {
    const daemon = surface().commands.find((c) => c.name() === "daemon")!;
    expect(names(daemon)).not.toContain("pair");
    expect(names(daemon)).toContain("start");
  });

  it("keeps host only when IRIX_ENABLE_CONNECTED_HOSTS is on", () => {
    vi.stubEnv("IRIX_ENABLE_CONNECTED_HOSTS", "1");
    expect(names(surface())).toContain("host");
  });

  describe("schedule and heartbeat", () => {
    it("are left out by default", () => {
      const program = surface();
      expect(names(program)).not.toContain("schedule");
      expect(names(program)).not.toContain("heartbeat");
    });

    it.each([
      ["IRIX_UNRESTRICTED", "1"],
      ["IRIX_UNRESTRICTED", "true"],
      ["IRIX_ALLOW_SCHEDULES", "1"],
      ["IRIX_ALLOW_SCHEDULES", "TRUE"],
    ])("are kept when %s=%s", (variable, value) => {
      vi.stubEnv(variable, value);
      expect(names(surface())).toEqual(expect.arrayContaining(["schedule", "heartbeat"]));
    });

    it("stay out for a value that is not on", () => {
      vi.stubEnv("IRIX_ALLOW_SCHEDULES", "0");
      expect(names(surface())).not.toContain("schedule");
    });
  });

  describe("send", () => {
    it("is kept for a person at a terminal (no PASEO_AGENT_ID)", () => {
      const program = surface();
      expect(names(program)).toContain("send");
      expect(agentNames(program)).toContain("send");
    });

    it("is left out for an agent while agent messaging is off", () => {
      vi.stubEnv("PASEO_AGENT_ID", "agent-1");
      const program = surface();
      expect(names(program)).not.toContain("send");
      expect(agentNames(program)).not.toContain("send");
      expect(agentNames(program)).toEqual(expect.arrayContaining(["ls", "run"]));
    });

    it.each(["IRIX_UNRESTRICTED", "IRIX_ALLOW_AGENT_MESSAGING"])(
      "is kept for an agent when %s is on",
      (variable) => {
        vi.stubEnv("PASEO_AGENT_ID", "agent-1");
        vi.stubEnv(variable, "1");
        const program = surface();
        expect(names(program)).toContain("send");
        expect(agentNames(program)).toContain("send");
      },
    );

    it("is kept for an agent when the switch is on but PASEO_AGENT_ID is empty", () => {
      vi.stubEnv("IRIX_ALLOW_AGENT_MESSAGING", "1");
      expect(names(surface())).toContain("send");
    });

    it("does not change schedule when messaging is switched on", () => {
      vi.stubEnv("PASEO_AGENT_ID", "agent-1");
      vi.stubEnv("IRIX_ALLOW_AGENT_MESSAGING", "1");
      expect(names(surface())).not.toContain("schedule");
    });
  });
});
