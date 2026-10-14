import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forgetUsernames, runClone, search } from "./projects.js";

const GITLAB = "https://gitlab.test";
const noop = () => {};
const instant = { sleep: async () => {}, pollIntervalMs: 1 };

let work: string;
let remotes: string;
let statePath: string;
const saved = { ...process.env };

interface FakeProject {
  path_with_namespace: string;
  namespace?: { kind: string };
  forked_from_project?: { path_with_namespace: string };
  /** `get` calls before a new fork reports its import as finished. */
  import_after?: number;
  fail?: string;
  polls?: number;
}

interface FakeState {
  username: string;
  list: unknown[];
  projects: Record<string, FakeProject>;
  /** `current-user get` fails, as when the token is wrong. */
  noUser?: boolean;
  importPolls: number;
  calls: string[];
}

// A stand-in for python-gitlab that keeps its state in a file, so a test can seed it and read back
// which commands were run. It answers the commands the plugin issues, in python-gitlab's JSON.
const FAKE_GITLAB = `
import { readFileSync, writeFileSync } from "node:fs";
const file = process.env.FAKE_GL_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2).filter((a) => !/^--(output|skip-login|server-url|gitlab)/u.test(a));
const flag = (name) => args.find((a) => a.startsWith("--" + name + "="))?.slice(name.length + 3);
const command = args.filter((a) => !a.startsWith("--")).join(" ");
state.calls.push(args.join(" "));
const save = () => writeFileSync(file, JSON.stringify(state));
const view = (p) => ({
  ...p,
  import_status: p.fail ? "failed" : (p.polls ?? 0) >= (p.import_after ?? 0) ? "finished" : "started",
  import_error: p.fail ?? null,
});
const fail = (message) => { save(); console.error(message); process.exit(1); };
if (command === "current-user get") { if (state.noUser) fail("401 Unauthorized"); save(); console.log(JSON.stringify({ id: 1, username: state.username })); }
else if (command === "project list") { save(); console.log(JSON.stringify(state.list)); }
else if (command === "project get") {
  const project = state.projects[flag("id")];
  if (!project) fail("Impossible to get (404: 404 Project Not Found)");
  project.polls = (project.polls ?? 0) + 1;
  save();
  console.log(JSON.stringify(view(project)));
} else if (command === "project-fork create") {
  const source = flag("project-id");
  const path = state.username + "/" + source.split("/").at(-1);
  if (state.projects[path]) fail("409 Project namespace name has already been taken");
  state.projects[path] = { path_with_namespace: path, namespace: { kind: "user" }, forked_from_project: { path_with_namespace: source }, import_after: state.importPolls, polls: 0 };
  save();
  console.log(JSON.stringify(view(state.projects[path])));
} else { fail("unexpected command: " + command); }
`;

function seed(partial: Partial<FakeState> = {}): void {
  const state: FakeState = {
    username: "me",
    list: [],
    projects: { "group/app": { path_with_namespace: "group/app", namespace: { kind: "group" } } },
    importPolls: 2,
    calls: [],
    ...partial,
  };
  writeFileSync(statePath, JSON.stringify(state));
}

const readState = (): FakeState => JSON.parse(readFileSync(statePath, "utf8")) as FakeState;

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
  work = mkdtempSync(join(tmpdir(), "wukong-gitlab-"));
  remotes = join(work, "remotes");
  statePath = join(work, "gitlab-state.json");
  // Real repositories served at the projects' clone URLs through git's own URL rewriting: the
  // original and the fork a Fork clone creates.
  bareRepoWithCommit("group/app");
  bareRepoWithCommit("me/app");

  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  const script = join(work, "fake-gitlab.mjs");
  writeFileSync(script, FAKE_GITLAB);
  // The command goes in wukong.json as an array: the environment variable splits on spaces, which
  // breaks on a Windows path such as C:\Program Files\nodejs\node.exe.
  writeFileSync(
    join(home, "wukong.json"),
    JSON.stringify({ gitlab: { command: [process.execPath, script] } }),
  );
  seed();
  forgetUsernames();

  process.env.PASEO_HOME = home;
  process.env.FAKE_GL_STATE = statePath;
  process.env.WUKONG_GITLAB_URL = GITLAB;
  process.env.WUKONG_CLONE_ROOT = join(work, "clones");
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(remotes).href}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = `${GITLAB}/`;
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
          web_url: `${GITLAB}/group/app`,
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
    expect(readState().calls.filter((c) => c === "current-user get")).toHaveLength(1);
  });

  it("asks python-gitlab for the full record of the user's projects, escaping a query like @file", async () => {
    await search({ query: "@secret" });
    const call = readState().calls.find((c) => c.startsWith("project list")) ?? "";
    expect(call).toContain("--search=@@secret");
    expect(call).toContain("--membership=true");
    expect(call).not.toContain("--simple");
  });

  it("explains how to configure GitLab when nothing is set", async () => {
    delete process.env.WUKONG_GITLAB_URL;
    writeFileSync(join(process.env.PASEO_HOME ?? "", "wukong.json"), "{}");
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
    expect(readState().calls.some((c) => c.startsWith("project-fork"))).toBe(false);
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
    expect(calls).toContain("project-fork create --project-id=group/app");
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
    expect(readState().calls.some((c) => c.startsWith("project-fork"))).toBe(false);
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
