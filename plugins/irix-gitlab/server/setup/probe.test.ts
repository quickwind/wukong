import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FAKE_GITLAB, fakeCalls, seedFake, type FakeState } from "./fake-gitlab.testing.js";
import { checkTools, expiresSoon, testSection, testToken } from "./probe.js";

let work: string;
let statePath: string;
let command: string[];
const saved = { ...process.env };

const seed = (partial: Partial<FakeState>) => seedFake(statePath, partial);
const calls = () => fakeCalls(statePath);

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
    seed({
      self: {
        active: true,
        revoked: false,
        expires_at: "2026-12-01",
        scopes: ["api", "read_repository", "write_repository"],
      },
    });
    expect(await testSection(command, "corp")).toEqual({
      result: "ok",
      expiresAt: "2026-12-01",
      missingScopes: [],
    });
    expect(calls()[0]?.args).toContain("--gitlab=corp");
  });

  it("lists the scopes the token lacks", async () => {
    seed({
      self: { active: true, revoked: false, expires_at: null, scopes: ["api", "read_repository"] },
    });
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
