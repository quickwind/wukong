import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FAKE_GITLAB, seedFake } from "./fake-gitlab.testing.js";
import { setupCreateSection, setupSave, setupStatus, setupTestSection } from "./handlers.js";

let work: string;
let home: string;
let cfg: string;
let env: NodeJS.ProcessEnv;
const saved = { ...process.env };

const GOOD_CFG =
  "[global]\ndefault = corp\n\n[corp]\nurl = https://gitlab.corp.example.com\nprivate_token = good\n\n[plain]\nurl = http://insecure.example.com\nprivate_token = x\n";

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "irix-setup-"));
  home = join(work, "home");
  cfg = join(work, "python-gitlab.cfg");
  mkdirSync(home, { recursive: true });
  const script = join(work, "fake-gitlab.mjs");
  writeFileSync(script, FAKE_GITLAB);
  writeFileSync(
    join(home, "irix.json"),
    JSON.stringify({ gitlab: { command: [process.execPath, script] } }),
  );
  const statePath = join(work, "state.json");
  seedFake(statePath, { requireToken: "good" });
  process.env.FAKE_GL_STATE = statePath;
  env = { ...process.env, PASEO_HOME: home, PYTHON_GITLAB_CFG: cfg };
  delete env.IRIX_GITLAB_URL;
  delete env.IRIX_GITLAB_SECTION;
  delete env.IRIX_GITLAB_COMMAND;
  delete env.IRIX_CLONE_ROOT;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("setupStatus", () => {
  it("lists sections, marks non-https ones unusable and reports the saved values", async () => {
    writeFileSync(cfg, GOOD_CFG);
    const status = await setupStatus(env);
    expect(status.tools.gitlab.found).toBe(true);
    expect(status.cfgPath).toBe(cfg);
    expect(status.sections).toEqual([
      { name: "corp", url: "https://gitlab.corp.example.com", usable: true },
      { name: "plain", url: "http://insecure.example.com", usable: false },
    ]);
    expect(status.saved.configSection).toBeNull();
    expect(status.overrides).toEqual([]);
    expect(status.defaultCloneRoot).toBe(
      process.platform === "win32"
        ? join(homedir(), "workspace", "gitlab")
        : "~/workspace/gitlab",
    );
  });

  it("marks sections the daemon would reject as unusable", async () => {
    writeFileSync(
      cfg,
      "[my work]\nurl = https://a.example.com\n\n[creds]\nurl = https://u:p@b.example.com\n\n[query]\nurl = https://c.example.com/?x=1\n\n[none]\nprivate_token = x\n\n[fine]\nurl = https://d.example.com\n",
    );
    const usable = (await setupStatus(env)).sections.map((s) => [s.name, s.usable]);
    expect(usable).toEqual([
      ["my work", false],
      ["creds", false],
      ["query", false],
      ["none", false],
      ["fine", true],
    ]);
  });

  it("names the environment variables that override the saved values", async () => {
    const status = await setupStatus({ ...env, IRIX_GITLAB_SECTION: "x", IRIX_CLONE_ROOT: "/p" });
    expect(status.overrides).toEqual(["IRIX_GITLAB_SECTION", "IRIX_CLONE_ROOT"]);
  });

  it("has no sections without a cfg file", async () => {
    expect((await setupStatus(env)).sections).toEqual([]);
  });
});

describe("setupTestSection", () => {
  it("tests a known section and flags a nearby expiry", async () => {
    writeFileSync(cfg, GOOD_CFG);
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    seedFake(process.env.FAKE_GL_STATE ?? "", {
      requireToken: "good",
      self: { active: true, revoked: false, expires_at: soon, scopes: ["api", "read_repository", "write_repository"] },
    });
    const result = await setupTestSection({ section: "corp" }, env);
    expect(result).toMatchObject({ result: "ok", expiresAt: soon, expiresSoon: true, missingScopes: [] });
  });

  it("rejects a section that is not in the cfg", async () => {
    writeFileSync(cfg, GOOD_CFG);
    await expect(setupTestSection({ section: "nope" }, env)).rejects.toThrow(/nope/);
  });
});

describe("setupCreateSection", () => {
  it("writes nothing when the token is rejected", async () => {
    await expect(
      setupCreateSection({ url: "https://gitlab.corp.example.com", token: "bad" }, env),
    ).rejects.toThrow(/rejected/i);
    expect(existsSync(cfg)).toBe(false);
  });

  it("writes a 0600 cfg and returns the new section when the token works", async () => {
    const out = await setupCreateSection(
      { url: "https://gitlab.corp.example.com/", token: "good" },
      env,
    );
    expect(out).toEqual({ section: "irix" });
    expect(readFileSync(cfg, "utf8")).toContain("url = https://gitlab.corp.example.com\n");
    if (process.platform !== "win32") expect(statSync(cfg).mode & 0o777).toBe(0o600);
  });

  it("picks a free name when irix exists", async () => {
    writeFileSync(cfg, "[irix]\nurl = https://other.example.com\nprivate_token = o\n");
    expect(
      await setupCreateSection({ url: "https://gitlab.corp.example.com", token: "good" }, env),
    ).toEqual({ section: "irix-2" });
  });

  it("replaces only the token of the named section and keeps its url", async () => {
    writeFileSync(cfg, GOOD_CFG.replace("private_token = good", "private_token = old"));
    await setupCreateSection(
      { url: "https://ignored.example.com", token: "good", replaceSection: "corp" },
      env,
    );
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain("[corp]\nurl = https://gitlab.corp.example.com\nprivate_token = good\n");
    expect(text).not.toContain("ignored.example.com");
  });

  it.each([
    ["http://gl.example.com", "good"],
    ["https://user:pw@gl.example.com", "good"],
    ["https://gl.example.com?x=1", "good"],
    ["https://gl.example.com", "bad\ntoken"],
    ["https://gl.example.com", ""],
  ])("refuses url %j with token %j", async (url, token) => {
    await expect(setupCreateSection({ url, token }, env)).rejects.toThrow();
    expect(existsSync(cfg)).toBe(false);
  });

  it("never lets the token reach a result, an error or the log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = JSON.stringify(
      await setupCreateSection({ url: "https://gitlab.corp.example.com", token: "good" }, env),
    );
    const failure = await setupCreateSection(
      { url: "https://gitlab.corp.example.com", token: "bad-secret-token" },
      env,
    ).catch((e: Error) => e.message);
    expect(out).not.toContain("good");
    expect(String(failure)).not.toContain("bad-secret-token");
    expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain("good");
  });
});

describe("setupSave", () => {
  it("takes the url from the cfg section and writes the three keys", async () => {
    writeFileSync(cfg, GOOD_CFG);
    const out = await setupSave({ section: "corp", cloneRoot: "~/projects" }, env);
    expect(out).toEqual({ url: "https://gitlab.corp.example.com", restartNeeded: true });
    expect(JSON.parse(readFileSync(join(home, "irix.json"), "utf8")).gitlab).toMatchObject({
      url: "https://gitlab.corp.example.com",
      configSection: "corp",
      cloneRoot: "~/projects",
    });
    const again = await setupSave({ section: "corp", cloneRoot: "~/other" }, env);
    expect(again.restartNeeded).toBe(false);
  });

  it("rejects an unknown or non-https section and a relative clone root", async () => {
    writeFileSync(cfg, GOOD_CFG);
    await expect(setupSave({ section: "nope", cloneRoot: "/p" }, env)).rejects.toThrow();
    await expect(setupSave({ section: "plain", cloneRoot: "/p" }, env)).rejects.toThrow(/https/);
    await expect(setupSave({ section: "corp", cloneRoot: "projects" }, env)).rejects.toThrow(
      /absolute/,
    );
  });
});
