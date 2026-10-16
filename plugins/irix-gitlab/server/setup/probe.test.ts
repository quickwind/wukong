import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkTools, expiresSoon, testSection, testToken } from "./probe.js";

// A stand-in for python-gitlab. `state.self` and `state.user` are the answers to the two commands
// the probe may issue; a string is a failure message printed on stderr. It records every call.
const FAKE_GITLAB = `
import { readFileSync, writeFileSync } from "node:fs";
const file = process.env.FAKE_GL_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const command = args.filter((a) => !a.startsWith("--")).join(" ");
const cfg = process.env.PYTHON_GITLAB_CFG ? readFileSync(process.env.PYTHON_GITLAB_CFG, "utf8") : "";
state.calls.push({ args, cfg, cfgPath: process.env.PYTHON_GITLAB_CFG, tokenInEnv: Boolean(process.env.GITLAB_PRIVATE_TOKEN) });
writeFileSync(file, JSON.stringify(state));
const answer = (value) => {
  if (typeof value === "string") { console.error(value); process.exit(1); }
  console.log(JSON.stringify(value));
};
if (args.includes("--version")) console.log("gitlab 8.6.0");
else if (command === "personal-access-token get") {
  if (state.requireToken && !cfg.includes("private_token = " + state.requireToken)) {
    console.error("Impossible to get (401: 401 Unauthorized)"); process.exit(1);
  }
  answer(state.self);
} else if (command === "current-user get") answer(state.user);
else { console.error("unexpected command: " + command); process.exit(1); }
`;

let work: string;
let statePath: string;
let command: string[];
const saved = { ...process.env };

interface FakeState {
  self: unknown;
  user: unknown;
  requireToken?: string;
  calls: { args: string[]; cfg: string; cfgPath?: string; tokenInEnv: boolean }[];
}

function seed(partial: Partial<FakeState>): void {
  const state: FakeState = {
    self: { active: true, revoked: false, expires_at: null, scopes: ["api", "read_repository", "write_repository"] },
    user: { id: 1, username: "me" },
    calls: [],
    ...partial,
  };
  writeFileSync(statePath, JSON.stringify(state));
}

const calls = (): FakeState["calls"] =>
  (JSON.parse(readFileSync(statePath, "utf8")) as FakeState).calls;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "irix-probe-"));
  statePath = join(work, "state.json");
  const script = join(work, "fake-gitlab.mjs");
  writeFileSync(script, FAKE_GITLAB);
  command = [process.execPath, script];
  process.env.FAKE_GL_STATE = statePath;
  seed({});
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("checkTools", () => {
  it("reports the gitlab command and its version", async () => {
    const tools = await checkTools(command);
    expect(tools.gitlab).toEqual({ found: true, version: "gitlab 8.6.0" });
  });

  it("reports a missing gitlab command", async () => {
    const tools = await checkTools([join(work, "no-such-command")]);
    expect(tools.gitlab).toEqual({ found: false, version: null });
  });
});

describe("testSection", () => {
  it("is ok with the expiry and no missing scopes", async () => {
    seed({ self: { active: true, revoked: false, expires_at: "2026-12-01", scopes: ["api", "read_repository", "write_repository"] } });
    expect(await testSection(command, "corp")).toEqual({
      result: "ok",
      expiresAt: "2026-12-01",
      missingScopes: [],
    });
    expect(calls()[0]?.args).toContain("--gitlab=corp");
  });

  it("lists the scopes the token lacks", async () => {
    seed({ self: { active: true, revoked: false, expires_at: null, scopes: ["api", "read_repository"] } });
    expect(await testSection(command, "corp")).toMatchObject({
      result: "ok",
      missingScopes: ["write_repository"],
    });
  });

  it("rejects a revoked token", async () => {
    seed({ self: { active: false, revoked: true, expires_at: null, scopes: ["api"] } });
    expect(await testSection(command, "corp")).toMatchObject({ result: "token-rejected" });
  });

  it("maps a 401 to token-rejected", async () => {
    seed({ self: "Impossible to get (401: 401 Unauthorized)" });
    expect(await testSection(command, "corp")).toMatchObject({ result: "token-rejected" });
  });

  it("maps a DNS failure to unreachable, not to the token", async () => {
    seed({ self: "requests.exceptions.ConnectionError: getaddrinfo ENOTFOUND gitlab.test" });
    expect(await testSection(command, "corp")).toMatchObject({ result: "unreachable" });
  });

  it("falls back to current-user when the token is not a personal access token", async () => {
    seed({ self: "Impossible to get (404: 404 Not Found)" });
    expect(await testSection(command, "corp")).toEqual({
      result: "ok",
      expiresAt: null,
      missingScopes: [],
    });
  });
});

describe("testToken", () => {
  it("tests the token through a temporary config and removes it", async () => {
    seed({ requireToken: "good" });
    const ok = await testToken(command, "https://gl.example.com", "good");
    expect(ok.result).toBe("ok");
    const [call] = calls();
    expect(call?.args.join(" ")).not.toContain("good");
    expect(call?.tokenInEnv).toBe(false);
    expect(call?.cfg).toContain("url = https://gl.example.com");
    const bad = await testToken(command, "https://gl.example.com", "bad");
    expect(bad.result).toBe("token-rejected");
  });

  it("leaves no temporary config behind", async () => {
    await testToken(command, "https://gl.example.com", "good");
    const cfgPath = calls()[0]?.cfgPath ?? "";
    expect(cfgPath).not.toBe("");
    expect(existsSync(cfgPath)).toBe(false);
  });
});

describe("expiresSoon", () => {
  const now = new Date("2026-10-16T00:00:00Z");
  it("is true inside 14 days, false outside, false without an expiry", () => {
    expect(expiresSoon("2026-10-29", now)).toBe(true);
    expect(expiresSoon("2026-11-01", now)).toBe(false);
    expect(expiresSoon(null, now)).toBe(false);
  });
});
