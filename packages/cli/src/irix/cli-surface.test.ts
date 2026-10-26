import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCli } from "../cli.js";
import { createCliParseArgv } from "../run.js";
import { markIrixCli } from "./defaults.js";
import { isCliSubagentApprovalRequired, promptCliSubagentApproval } from "./surface.js";

describe("Irix CLI surface", () => {
  const unused = ["clone", "onboard", "pair", "hub", "speech", "host"];
  const names = (command: ReturnType<typeof createCli>) => command.commands.map((c) => c.name());

  afterEach(() => {
    markIrixCli(false);
    vi.unstubAllEnvs();
  });

  it("keeps the upstream commands outside the Irix edition", () => {
    markIrixCli(false);
    const cli = createCli();
    expect(names(cli)).toEqual(expect.arrayContaining(unused));
    const daemon = cli.commands.find((command) => command.name() === "daemon");
    expect(daemon && names(daemon)).toContain("pair");
  });

  it("leaves out clone, onboard, pair, hub, speech and host in the Irix edition", () => {
    markIrixCli(true);
    const cli = createCli();
    for (const name of unused) expect(names(cli)).not.toContain(name);
    const daemon = cli.commands.find((command) => command.name() === "daemon");
    expect(daemon && names(daemon)).not.toContain("pair");
  });

  it("keeps the host command only when IRIX_ENABLE_CONNECTED_HOSTS is set", () => {
    markIrixCli(true);
    vi.stubEnv("IRIX_UNRESTRICTED", "1");
    expect(names(createCli())).not.toContain("host");
    vi.stubEnv("IRIX_ENABLE_CONNECTED_HOSTS", "1");
    expect(names(createCli())).toContain("host");
  });

  describe("commands the daemon switches off", () => {
    const agentSubcommands = (command: ReturnType<typeof createCli>) => {
      const agent = command.commands.find((c) => c.name() === "agent");
      return agent ? names(agent) : [];
    };

    beforeEach(() => {
      vi.stubEnv("IRIX_UNRESTRICTED", "");
      vi.stubEnv("IRIX_ALLOW_SCHEDULES", "");
      vi.stubEnv("IRIX_ALLOW_AGENT_MESSAGING", "");
      vi.stubEnv("PASEO_AGENT_ID", "");
      markIrixCli(true);
    });

    it("keeps the commands Irix does use", () => {
      expect(names(createCli())).toEqual(
        expect.arrayContaining(["run", "ls", "send", "daemon", "plugin", "provider"]),
      );
    });

    it("leaves out schedule and heartbeat by default, from the command list and the help", () => {
      const cli = createCli();
      expect(names(cli)).not.toContain("schedule");
      expect(names(cli)).not.toContain("heartbeat");
      expect(cli.helpInformation()).not.toMatch(/\bschedule\b|\bheartbeat\b/u);
    });

    it.each(["IRIX_UNRESTRICTED", "IRIX_ALLOW_SCHEDULES"])(
      "shows schedule and heartbeat when %s is set",
      (variable) => {
        vi.stubEnv(variable, "1");
        expect(names(createCli())).toEqual(expect.arrayContaining(["schedule", "heartbeat"]));
      },
    );

    it("keeps send for a person, and drops it for an agent, while messages between agents are off", () => {
      expect(names(createCli())).toContain("send");
      expect(agentSubcommands(createCli())).toContain("send");

      vi.stubEnv("PASEO_AGENT_ID", "agent-1");
      const cli = createCli();
      expect(names(cli)).not.toContain("send");
      expect(agentSubcommands(cli)).not.toContain("send");
    });

    it.each(["IRIX_UNRESTRICTED", "IRIX_ALLOW_AGENT_MESSAGING"])(
      "keeps send for an agent when %s is set",
      (variable) => {
        vi.stubEnv("PASEO_AGENT_ID", "agent-1");
        vi.stubEnv(variable, "1");
        expect(names(createCli())).toContain("send");
      },
    );
  });

  it("names itself irix and points at the Irix home", () => {
    markIrixCli(true);
    const help = createCli().helpInformation().replace(/\s+/gu, " ");
    expect(help).toContain("Usage: irix");
    expect(help).toContain("Irix CLI");
    expect(help).toContain("(default: ~/.irix)");
    expect(help).not.toContain("~/.paseo");
    const ls = createCli().commands.find((command) => command.name() === "ls");
    expect(ls?.helpInformation()).not.toContain("~/.paseo");
  });

  it("shows help when run with no arguments, instead of onboarding", () => {
    markIrixCli(true);
    const nodeArgv: [string, string] = ["node", "irix"];
    expect(createCliParseArgv({ argv: [], cwd: "/tmp", nodeArgv })).toEqual([
      "node",
      "irix",
      "--help",
    ]);
    expect(createCliParseArgv({ argv: ["--relay"], cwd: "/tmp", nodeArgv })).toEqual([
      "node",
      "irix",
      "--relay",
    ]);
  });

  it("still onboards with no arguments outside the Irix edition", () => {
    markIrixCli(false);
    const nodeArgv: [string, string] = ["node", "paseo"];
    expect(createCliParseArgv({ argv: [], cwd: "/tmp", nodeArgv })).toEqual([
      "node",
      "paseo",
      "onboard",
    ]);
  });

  it("does not turn a directory argument into an open-in-desktop request", () => {
    const nodeArgv: [string, string] = ["node", "irix"];
    markIrixCli(false);
    expect(createCliParseArgv({ argv: ["."], cwd: tmpdir(), nodeArgv })).toMatchObject({
      kind: "open-project",
    });
    markIrixCli(true);
    expect(createCliParseArgv({ argv: ["."], cwd: tmpdir(), nodeArgv })).toEqual([
      "node",
      "irix",
      ".",
    ]);
  });

  it("prompts for yes/no in the CLI terminal when subagent approval is required", async () => {
    expect(isCliSubagentApprovalRequired("/nonexistent-home", {})).toBe(true);

    const inputYes = new PassThrough();
    const outputYes = new PassThrough();
    const approvePromise = promptCliSubagentApproval(
      { provider: "claude", cwd: "/tmp", prompt: "fix bug" },
      { input: inputYes, output: outputYes },
    );
    inputYes.write("yes\n");
    await expect(approvePromise).resolves.toBe(true);

    const inputNo = new PassThrough();
    const outputNo = new PassThrough();
    const rejectPromise = promptCliSubagentApproval(
      { provider: "claude", cwd: "/tmp", prompt: "fix bug" },
      { input: inputNo, output: outputNo },
    );
    inputNo.write("invalid\nno\n");
    await expect(rejectPromise).resolves.toBe(false);
  });
});
