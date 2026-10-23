import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { forgetApis } from "../api.js";
import { installSystemCa } from "../system-ca.js";
import { startFakeGitLab, writeCfg, type FakeGitLab } from "../test/fake-gitlab.js";
import { expiresSoon, testSection, testToken } from "./probe.js";

let fake: FakeGitLab;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  fake = await startFakeGitLab();
  installSystemCa({ extraFiles: [fake.certFile] });
});

afterAll(() => fake.close());

beforeEach(() => {
  forgetApis();
  fake.seed({ requireToken: "good" });
  const cfg = join(mkdtempSync(join(tmpdir(), "irix-probe-")), "python-gitlab.cfg");
  writeCfg(cfg, fake);
  env = { ...process.env, PYTHON_GITLAB_CFG: cfg };
  delete env.GITLAB_PRIVATE_TOKEN;
});

describe("testSection", () => {
  it("is ok with the expiry and no missing scopes, sending the section's token", async () => {
    fake.seed({
      requireToken: "good",
      self: {
        active: true,
        revoked: false,
        expires_at: "2026-12-01",
        scopes: ["api", "read_repository", "write_repository"],
      },
    });
    expect(await testSection(fake.url, "corp", env)).toEqual({
      result: "ok",
      expiresAt: "2026-12-01",
      missingScopes: [],
    });
    expect(fake.state.tokens).toEqual(["good"]);
  });

  it("lists the scopes the token lacks", async () => {
    fake.seed({
      requireToken: "good",
      self: { active: true, revoked: false, expires_at: null, scopes: ["api", "read_repository"] },
    });
    expect(await testSection(fake.url, "corp", env)).toMatchObject({
      result: "ok",
      missingScopes: ["write_repository"],
    });
  });

  it("rejects a revoked token", async () => {
    fake.seed({
      requireToken: "good",
      self: { active: false, revoked: true, expires_at: null, scopes: ["api"] },
    });
    expect(await testSection(fake.url, "corp", env)).toMatchObject({ result: "token-rejected" });
  });

  it("maps a 401 to token-rejected", async () => {
    fake.seed({ requireToken: "other" });
    expect(await testSection(fake.url, "corp", env)).toMatchObject({ result: "token-rejected" });
  });

  it("maps a refused connection to unreachable, not to the token", async () => {
    const closed = await startFakeGitLab();
    const { url } = closed;
    await closed.close();
    expect(await testSection(url, "corp", env)).toMatchObject({ result: "unreachable" });
  });

  it("says unreachable-or-rejected, never ok, when the section has no token", async () => {
    const empty = join(mkdtempSync(join(tmpdir(), "irix-probe-")), "empty.cfg");
    writeCfg(empty, fake, { token: "" });
    const outcome = await testSection(fake.url, "corp", { ...env, PYTHON_GITLAB_CFG: empty });
    expect(outcome.result).toBe("token-rejected");
  });

  it("falls back to the current user when the token is not a personal access token", async () => {
    fake.seed({ requireToken: "good", self: { status: 404, message: "404 Not Found" } });
    expect(await testSection(fake.url, "corp", env)).toEqual({
      result: "ok",
      expiresAt: null,
      missingScopes: [],
    });
  });
});

describe("testToken", () => {
  it("tests a token that is not in any config", async () => {
    expect((await testToken(fake.url, "good")).result).toBe("ok");
    expect((await testToken(fake.url, "bad")).result).toBe("token-rejected");
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
