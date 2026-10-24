import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createGitMetadataGenerator,
  type StructuredTextGeneration,
} from "../server/session/checkout/git-metadata-generator.js";
import { activateIrixPolicy } from "./policy.js";
import {
  createIrixGitMetadataGenerator,
  draftPullRequestText,
  draftPullRequestTextForCheckout,
  humanizeBranchName,
} from "./pr-text.js";

describe("humanizeBranchName", () => {
  it.each([
    ["fix-login-bug", "Fix login bug"],
    ["add_new__thing", "Add new thing"],
    ["feature/foo-bar", "Feature/foo bar"],
    ["", "Update changes"],
    [null, "Update changes"],
  ])("%j -> %j", (branch, title) => {
    expect(humanizeBranchName(branch)).toBe(title);
  });
});

describe("draftPullRequestText", () => {
  it("uses the subject and body of a single commit", () => {
    expect(
      draftPullRequestText({
        branch: "fix-login-bug",
        subjects: ["Fix the login redirect"],
        singleCommitBody: "\nIt looped on expired sessions.\n",
      }),
    ).toEqual({ title: "Fix the login redirect", body: "It looped on expired sessions." });
  });

  it("uses the branch name and lists several commits, oldest first", () => {
    expect(
      draftPullRequestText({
        branch: "fix-login-bug",
        subjects: ["Third", "Second", "First"],
        singleCommitBody: "",
      }),
    ).toEqual({ title: "Fix login bug", body: "- First\n- Second\n- Third" });
  });

  it("caps a long list", () => {
    const subjects = Array.from({ length: 60 }, (_, i) => `c${60 - i}`);
    const { body } = draftPullRequestText({ branch: "b", subjects, singleCommitBody: "" });
    expect(body.split("\n")).toHaveLength(51);
    expect(body.endsWith("- and 10 more")).toBe(true);
  });

  it("still gives a title when the branch adds nothing", () => {
    expect(draftPullRequestText({ branch: "wip", subjects: [], singleCommitBody: "" })).toEqual({
      title: "Wip",
      body: "",
    });
  });
});

describe("the Irix pull request text generator", () => {
  let repo: string;
  let deactivate: (() => void) | undefined;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      stdio: "ignore",
    });
  const commit = (message: string) => {
    writeFileSync(join(repo, "f.txt"), `${message}\n${Math.random()}`);
    git("add", ".");
    git("commit", "-m", message);
  };

  let modelCalls = 0;
  const generation: StructuredTextGeneration = {
    async generate<T>(): Promise<T> {
      modelCalls += 1;
      return { title: "From the model", body: "Model body" } as T;
    },
  };
  const makeGenerator = () =>
    createIrixGitMetadataGenerator(createGitMetadataGenerator, {
      workspaceGitService: {
        getCheckoutDiff: async () => ({ diff: "", structured: [] }),
        resolveRepoRoot: async () => repo,
      } as never,
      generation,
    });

  beforeEach(() => {
    modelCalls = 0;
    repo = mkdtempSync(join(tmpdir(), "irix-pr-text-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commit("Initial");
  });
  afterEach(() => {
    deactivate?.();
    deactivate = undefined;
    rmSync(repo, { recursive: true, force: true });
  });

  it("answers at once with empty text, without the model, so GitLab can fill it in", async () => {
    deactivate = activateIrixPolicy();
    git("checkout", "-q", "-b", "fix-login-bug");
    commit("Fix the login redirect");
    expect(await makeGenerator().generatePullRequestText(repo)).toEqual({ title: "", body: "" });
    expect(modelCalls).toBe(0);
  });

  it("drafts a one-commit branch from its commit", async () => {
    git("checkout", "-q", "-b", "fix-login-bug");
    commit("Fix the login redirect\n\nIt looped on expired sessions.");
    expect(await draftPullRequestTextForCheckout(repo)).toEqual({
      title: "Fix the login redirect",
      body: "It looped on expired sessions.",
    });
  });

  it("drafts a many-commit branch from its name and the commit subjects", async () => {
    git("checkout", "-q", "-b", "fix-login-bug");
    commit("First change");
    commit("Second change");
    expect(await draftPullRequestTextForCheckout(repo)).toEqual({
      title: "Fix login bug",
      body: "- First change\n- Second change",
    });
  });

  it("leaves upstream's model-written text alone when the Irix policy is off", async () => {
    git("checkout", "-q", "-b", "fix-login-bug");
    commit("Only change");
    await expect(makeGenerator().generatePullRequestText(repo)).resolves.toEqual({
      title: "From the model",
      body: "Model body",
    });
    expect(modelCalls).toBe(1);
  });
});
