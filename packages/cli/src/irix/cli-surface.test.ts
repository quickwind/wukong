import { afterEach, describe, expect, it } from "vitest";
import { createCli } from "../cli.js";
import { createCliParseArgv } from "../run.js";
import { markIrixCli } from "./defaults.js";

describe("Irix CLI surface", () => {
  const unused = ["clone", "onboard", "pair", "hub", "speech"];
  const names = (command: ReturnType<typeof createCli>) => command.commands.map((c) => c.name());

  afterEach(() => markIrixCli(false));

  it("keeps the upstream commands outside the Irix edition", () => {
    markIrixCli(false);
    const cli = createCli();
    expect(names(cli)).toEqual(expect.arrayContaining(unused));
    const daemon = cli.commands.find((command) => command.name() === "daemon");
    expect(daemon && names(daemon)).toContain("pair");
  });

  it("leaves out clone, onboard, pair, hub and speech in the Irix edition", () => {
    markIrixCli(true);
    const cli = createCli();
    for (const name of unused) expect(names(cli)).not.toContain(name);
    const daemon = cli.commands.find((command) => command.name() === "daemon");
    expect(daemon && names(daemon)).not.toContain("pair");
  });

  it("keeps the commands Irix does use", () => {
    markIrixCli(true);
    expect(names(createCli())).toEqual(
      expect.arrayContaining(["run", "ls", "send", "daemon", "plugin", "provider", "schedule"]),
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
    expect(createCliParseArgv({ argv: ["."], cwd: "/tmp", nodeArgv })).toMatchObject({
      kind: "open-project",
    });
    markIrixCli(true);
    expect(createCliParseArgv({ argv: ["."], cwd: "/tmp", nodeArgv })).toEqual([
      "node",
      "irix",
      ".",
    ]);
  });
});
