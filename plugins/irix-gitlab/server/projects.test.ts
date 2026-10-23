import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { forgetApis } from "./api.js";
import { forgetUsernames, runClone, search } from "./projects.js";
import { installSystemCa } from "./system-ca.js";
import { startFakeGitLab, writeCfg, type FakeGitLab, type FakeState } from "./test/fake-gitlab.js";

const noop = () => {};
const instant = { sleep: async () => {}, pollIntervalMs: 1 };

let work: string;
let remotes: string;
const saved = { ...process.env };

let fake: FakeGitLab;

beforeAll(async () => {
  fake = await startFakeGitLab();
  installSystemCa({ extraFiles: [fake.certFile] });
});

afterAll(() => fake.close());

function seed(partial: Partial<FakeState> = {}): void {
  fake.seed(partial);
}

const readState = (): FakeState => fake.state;

function bareRepoWithCommit(projectPath: string): void {
  const bare = join(remotes, `${projectPath}.git`);
  mkdirSync(join(bare, ".."), { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare]);
  const seedDir = mkdtempSync(join(work, "seed-"));
  execFileSync("git", ["clone", bare, seedDir], { stdio: "ignore" });
  writeFileSync(join(seedDir, "README.md"), projectPath);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", seedDir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      stdio: "ignore",
    });
  git("add", ".");
  git("commit", "-m", "init");
  git("push", "origin", "HEAD:main");
}

const git = (directory: string, ...args: string[]) =>
  execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "irix-gitlab-"));
  remotes = join(work, "remotes");
  // Real repositories served at the projects' clone URLs through git's own URL rewriting: the
  // original and the fork a Fork clone creates.
  bareRepoWithCommit("group/app");
  bareRepoWithCommit("me/app");

  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  const cfg = join(work, "python-gitlab.cfg");
  writeCfg(cfg, fake);
  seed();
  forgetUsernames();
  forgetApis();

  process.env.PASEO_HOME = home;
  process.env.PYTHON_GITLAB_CFG = cfg;
  delete process.env.GITLAB_PRIVATE_TOKEN;
  process.env.IRIX_GITLAB_URL = fake.url;
  process.env.IRIX_CLONE_ROOT = join(work, "clones");
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(remotes).href}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = `${fake.url}/`;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("search", () => {
  it("offers Fork clone for every project that is not the user's own", async () => {
    seed({
      list: [
        {
          path_with_namespace: "group/app",
          name: "app",
          description: "An app",
          web_url: `${fake.url}/group/app`,
          namespace: { kind: "group" },
        },
        // A colleague's personal project, shared with the user.
        { path_with_namespace: "alice/shared", name: "shared", namespace: { kind: "user" } },
        // The user's own project and the user's own fork.
        { path_with_namespace: "me/mine", name: "mine", namespace: { kind: "user" } },
        {
          path_with_namespace: "me/app",
          name: "app",
          namespace: { kind: "user" },
          forked_from_project: { path_with_namespace: "group/app" },
        },
      ],
    });
    const result = await search({ query: "app" });
    expect(result.cloneRoot).toBe(join(work, "clones"));
    expect(result.projects.map((p) => [p.path, p.namespaceKind, p.forkedFrom, p.canFork])).toEqual([
      ["group/app", "group", null, true],
      ["alice/shared", "user", null, true],
      ["me/mine", "user", null, false],
      ["me/app", "user", "group/app", false],
    ]);
  });

  it("falls back to team projects only when GitLab will not say who the user is", async () => {
    seed({
      noUser: true,
      list: [
        { path_with_namespace: "group/app", name: "app", namespace: { kind: "group" } },
        { path_with_namespace: "alice/shared", name: "shared", namespace: { kind: "user" } },
      ],
    });
    const result = await search({ query: "" });
    expect(result.projects.map((p) => [p.path, p.canFork])).toEqual([
      ["group/app", true],
      ["alice/shared", false],
    ]);
  });

  it("asks who the user is once, not on every search", async () => {
    await search({ query: "a" });
    await search({ query: "b" });
    expect(readState().calls.filter((c) => c === "GET /user")).toHaveLength(1);
  });

  it("asks GitLab for the full record of the user's projects, sending the query as it was typed", async () => {
    await search({ query: "@secret" });
    const call = readState().calls.find((c) => c.startsWith("GET /projects?")) ?? "";
    const query = new URLSearchParams(call.split("?")[1]);
    expect(query.get("search")).toBe("@secret");
    expect(query.get("membership")).toBe("true");
    expect(query.has("simple")).toBe(false);
  });

  it("sends the token from the python-gitlab config", async () => {
    await search({ query: "a" });
    expect(new Set(readState().tokens)).toEqual(new Set(["good"]));
  });

  it("explains how to configure GitLab when nothing is set", async () => {
    delete process.env.IRIX_GITLAB_URL;
    writeFileSync(join(process.env.PASEO_HOME ?? "", "irix.json"), "{}");
    await expect(search({ query: "" })).rejects.toThrow(/not configured/);
  });
});

describe("clone", () => {
  it("clones into the clone root", async () => {
    const result = await runClone({ path: "group/app" }, noop);
    expect(result).toEqual({
      directory: join(work, "clones", "app"),
      alreadyCloned: false,
      clonedPath: "group/app",
      forkedFrom: null,
    });
    expect(existsSync(join(result.directory, "README.md"))).toBe(true);
    expect(readState().calls.some((c) => c.endsWith("/fork"))).toBe(false);
  });

  it("reuses an existing clone of the same project", async () => {
    await runClone({ path: "group/app" }, noop);
    expect((await runClone({ path: "group/app" }, noop)).alreadyCloned).toBe(true);
  });

  it("never writes into an unrelated folder", async () => {
    const taken = join(work, "clones", "app");
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, "other.txt"), "x");
    await expect(runClone({ path: "group/app" }, noop)).rejects.toThrow(/not a clone/);
  });

  it("rejects paths that could escape or inject options", async () => {
    for (const path of ["app", "../x/app", "group/..", "-oProxy=x/app", "group//app", "a/b c"]) {
      await expect(runClone({ path }, noop)).rejects.toThrow(/group\/project/);
    }
  });

  it("requires an absolute clone folder", async () => {
    await expect(
      runClone({ path: "group/app", parentDirectory: "relative/dir" }, noop),
    ).rejects.toThrow(/absolute/);
  });
});

describe("fork clone", () => {
  it("forks into the user's namespace, waits for GitLab to build it, clones it and adds upstream", async () => {
    const steps: string[] = [];
    const result = await runClone({ path: "group/app", fork: true }, (s) => steps.push(s), instant);

    expect(result).toMatchObject({
      directory: join(work, "clones", "app"),
      alreadyCloned: false,
      clonedPath: "me/app",
      forkedFrom: "group/app",
    });
    expect(steps).toEqual(
      expect.arrayContaining([
        "Forking into your namespace…",
        "Waiting for GitLab to build your fork…",
        "Cloning…",
      ]),
    );
    const calls = readState().calls;
    expect(calls).toContain("POST /projects/group%2Fapp/fork");
    // The clone is of the fork; the original is the upstream remote.
    expect(git(result.directory, "remote", "get-url", "origin")).toMatch(/me\/app\.git$/);
    expect(git(result.directory, "remote", "get-url", "upstream")).toMatch(/group\/app\.git$/);
    expect(existsSync(join(result.directory, "README.md"))).toBe(true);
    expect(readFileSync(join(result.directory, "README.md"), "utf8")).toBe("me/app");
  });

  it("reuses a fork the user already has instead of forking again", async () => {
    seed({
      projects: {
        "group/app": { path_with_namespace: "group/app", namespace: { kind: "group" } },
        "me/app": {
          path_with_namespace: "me/app",
          namespace: { kind: "user" },
          forked_from_project: { path_with_namespace: "group/app" },
        },
      },
    });
    const steps: string[] = [];
    const result = await runClone({ path: "group/app", fork: true }, (s) => steps.push(s), instant);
    expect(result.clonedPath).toBe("me/app");
    expect(steps).toContain("Using your existing fork…");
    expect(readState().calls.some((c) => c.endsWith("/fork"))).toBe(false);
  });

  it("adds the upstream remote to an existing clone of the fork, once", async () => {
    await runClone({ path: "group/app", fork: true }, noop, instant);
    seed({
      projects: {
        "group/app": { path_with_namespace: "group/app", namespace: { kind: "group" } },
        "me/app": {
          path_with_namespace: "me/app",
          namespace: { kind: "user" },
          forked_from_project: { path_with_namespace: "group/app" },
        },
      },
    });
    const again = await runClone({ path: "group/app", fork: true }, noop, instant);
    expect(again.alreadyCloned).toBe(true);
    expect(git(again.directory, "remote").split("\n").sort()).toEqual(["origin", "upstream"]);
  });

  it("will not touch a project of the same name that is not a fork of this one", async () => {
    seed({
      projects: {
        "group/app": { path_with_namespace: "group/app", namespace: { kind: "group" } },
        "me/app": { path_with_namespace: "me/app", namespace: { kind: "user" } },
      },
    });
    await expect(runClone({ path: "group/app", fork: true }, noop, instant)).rejects.toThrow(
      "me/app already exists and is not a fork of group/app",
    );
  });

  it("refuses to fork a project that is already the user's", async () => {
    await expect(runClone({ path: "me/app", fork: true }, noop, instant)).rejects.toThrow(
      /already in your namespace/,
    );
  });

  it("reports a fork GitLab fails to build", async () => {
    seed({
      projects: {
        "group/app": { path_with_namespace: "group/app", namespace: { kind: "group" } },
        "me/app": {
          path_with_namespace: "me/app",
          namespace: { kind: "user" },
          forked_from_project: { path_with_namespace: "group/app" },
          fail: "Repository is too large to fork",
        },
      },
    });
    await expect(runClone({ path: "group/app", fork: true }, noop, instant)).rejects.toThrow(
      "Repository is too large to fork",
    );
  });

  it("gives up if GitLab never finishes the fork", async () => {
    seed({ importPolls: 1_000_000 });
    await expect(
      runClone({ path: "group/app", fork: true }, noop, { ...instant, forkTimeoutMs: 20 }),
    ).rejects.toThrow(/still building/);
  });

  it("forks a colleague's personal project the same way", async () => {
    bareRepoWithCommit("alice/shared");
    bareRepoWithCommit("me/shared");
    seed({
      projects: {
        "alice/shared": { path_with_namespace: "alice/shared", namespace: { kind: "user" } },
      },
    });
    const result = await runClone({ path: "alice/shared", fork: true }, noop, instant);
    expect(result).toMatchObject({ clonedPath: "me/shared", forkedFrom: "alice/shared" });
    expect(git(result.directory, "remote", "get-url", "upstream")).toMatch(/alice\/shared\.git$/);
  });
});
