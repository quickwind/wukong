import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applyIrixDefaults, irixDefaultHome } from "./defaults.js";

function freshHome() {
  return mkdtempSync(path.join(tmpdir(), "irix-defaults-"));
}

const configPath = (home: string) => path.join(home, "config.json");
const writeConfig = (home: string, text: string) => writeFileSync(configPath(home), text);
const readText = (home: string) => readFileSync(configPath(home), "utf8");
const readConfig = (home: string) => JSON.parse(readText(home));

describe("applyIrixDefaults", () => {
  it("uses ~/.irix and writes a config that listens on 6899 and hands agents Paseo's tools", () => {
    const home = freshHome();
    const env: NodeJS.ProcessEnv = {};
    applyIrixDefaults(env, home);
    expect(env.PASEO_HOME).toBe(irixDefaultHome(home));
    expect(readConfig(env.PASEO_HOME ?? "")).toEqual({
      version: 1,
      daemon: { listen: "127.0.0.1:6899", mcp: { injectIntoAgents: true } },
    });
  });

  it("ignores PASEO_HOME and PASEO_HOST inherited from a terminal opened inside Paseo", () => {
    const home = freshHome();
    const env: NodeJS.ProcessEnv = { PASEO_HOME: path.join(home, ".paseo"), PASEO_HOST: "x:6767" };
    applyIrixDefaults(env, home);
    expect(env.PASEO_HOME).toBe(irixDefaultHome(home));
    expect(env.PASEO_HOST).toBeUndefined();
    expect(existsSync(path.join(home, ".paseo"))).toBe(false);
  });

  it("honours IRIX_HOME and writes its config there", () => {
    const home = freshHome();
    const explicit = path.join(freshHome(), "mine");
    const env: NodeJS.ProcessEnv = { IRIX_HOME: explicit, PASEO_HOME: "/elsewhere" };
    applyIrixDefaults(env, home);
    expect(env.PASEO_HOME).toBe(explicit);
    expect(existsSync(configPath(explicit))).toBe(true);
    expect(existsSync(path.join(home, ".irix"))).toBe(false);
  });

  it("expands ~ in IRIX_HOME, including the Windows backslash form", () => {
    const home = freshHome();
    for (const spelling of ["~/work", "~\\work"]) {
      applyIrixDefaults({ IRIX_HOME: spelling }, home);
      expect(existsSync(path.join(home, "work", "config.json"))).toBe(true);
    }
  });

  it("never replaces an existing config's own settings", () => {
    const home = freshHome();
    writeConfig(home, '{"version":1,"daemon":{"listen":"127.0.0.1:7000"}}');
    applyIrixDefaults({ IRIX_HOME: home }, home);
    expect(readConfig(home).daemon.listen).toBe("127.0.0.1:7000");
  });
});

describe("handing Paseo's tools to agents", () => {
  it("turns the switch on in an existing config that has no value for it, keeping the rest", () => {
    const home = freshHome();
    writeConfig(home, '{"version":1,"daemon":{"listen":"127.0.0.1:7000","mcp":{"enabled":true}}}');
    applyIrixDefaults({ IRIX_HOME: home }, home);
    expect(readConfig(home)).toEqual({
      version: 1,
      daemon: { listen: "127.0.0.1:7000", mcp: { enabled: true, injectIntoAgents: true } },
    });
  });

  it("adds the daemon and mcp sections when the config has neither", () => {
    const home = freshHome();
    writeConfig(home, '{"version":1}');
    applyIrixDefaults({ IRIX_HOME: home }, home);
    expect(readConfig(home).daemon).toEqual({ mcp: { injectIntoAgents: true } });
  });

  it("respects a value the user set, on or off", () => {
    for (const value of [true, false]) {
      const home = freshHome();
      const text = `{"version":1,"daemon":{"mcp":{"injectIntoAgents":${value}}}}`;
      writeConfig(home, text);
      applyIrixDefaults({ IRIX_HOME: home }, home);
      expect(readText(home)).toBe(text);
    }
  });

  it("leaves a config it cannot read exactly as it is", () => {
    for (const text of ["not json", "[1,2]", '{"daemon":"x"}', '{"daemon":{"mcp":[]}}']) {
      const home = freshHome();
      writeConfig(home, text);
      expect(() => applyIrixDefaults({ IRIX_HOME: home }, home)).not.toThrow();
      expect(readText(home)).toBe(text);
    }
  });
});
