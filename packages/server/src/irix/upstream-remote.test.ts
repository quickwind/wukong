import { afterEach, describe, expect, it } from "vitest";

import type { RunGitCommand } from "../utils/run-git-command.js";
import { activateIrixPolicy } from "./policy.js";
import { fetchUpstreamRemote, listUpstreamBranchDetails } from "./upstream-remote.js";

function fakeGit(responses: Record<string, string | Error>) {
  const calls: string[][] = [];
  const run = (async (args: string[]) => {
    calls.push(args);
    const response = responses[args[0] === "config" ? "config" : args[0]!];
    if (response instanceof Error) throw response;
    return { stdout: response ?? "", stderr: "" };
  }) as unknown as RunGitCommand;
  return { run, calls };
}

describe("upstream remote", () => {
  let deactivate: (() => void) | undefined;
  afterEach(() => deactivate?.());

  it("does nothing when Irix is not active", async () => {
    const git = fakeGit({ config: "git@host:g/app.git\n" });
    await fetchUpstreamRemote("/repo", git.run);
    expect(git.calls).toEqual([]);
    expect(await listUpstreamBranchDetails("/repo", {}, git.run)).toEqual([]);
  });

  it("fetches upstream only when the remote exists, and ignores a failed fetch", async () => {
    deactivate = activateIrixPolicy();
    const none = fakeGit({ config: new Error("no such remote") });
    await fetchUpstreamRemote("/repo", none.run);
    expect(none.calls.map((call) => call[0])).toEqual(["config"]);

    const failing = fakeGit({ config: "git@host:g/app.git\n", fetch: new Error("denied") });
    await expect(fetchUpstreamRemote("/repo", failing.run)).resolves.toBeUndefined();
    expect(failing.calls[1]).toEqual(["fetch", "upstream", "--prune"]);
  });

  it("lists upstream branches, filtered by query and limited", async () => {
    deactivate = activateIrixPolicy();
    const git = fakeGit({
      "for-each-ref": [
        "refs/remotes/upstream/HEAD\t30",
        "refs/remotes/upstream/main\t20",
        "refs/remotes/upstream/release/2.0\t10",
      ].join("\n"),
    });
    expect(await listUpstreamBranchDetails("/repo", {}, git.run)).toEqual([
      { name: "main", committerDate: 20, hasRemote: true, remote: "upstream" },
      { name: "release/2.0", committerDate: 10, hasRemote: true, remote: "upstream" },
    ]);
    expect(await listUpstreamBranchDetails("/repo", { query: "REL" }, git.run)).toEqual([
      { name: "release/2.0", committerDate: 10, hasRemote: true, remote: "upstream" },
    ]);
    expect(await listUpstreamBranchDetails("/repo", { limit: 1 }, git.run)).toHaveLength(1);
  });
});
