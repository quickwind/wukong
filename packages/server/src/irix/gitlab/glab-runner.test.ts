// Contract test: upstream's GitLab service, driven through the glab-compatible runner, must
// reach the python-gitlab client with the right arguments. A failure after an upstream sync
// means upstream changed a `glab` command line and the runner needs the matching translation.

import { describe, expect, it, vi } from "vitest";

import { createGitLabService } from "../../services/gitlab-service.js";
import { createGlabCompatRunner } from "./glab-runner.js";
import type { GitLabClient } from "./python-client.js";

const PROJECT = "group/sub/app";

const mergeRequest = {
  iid: 7,
  title: "Add thing",
  web_url: "https://gitlab.example.com/group/sub/app/-/merge_requests/7",
  state: "opened",
  source_branch: "feature",
  target_branch: "main",
  sha: "abc123",
  detailed_merge_status: "mergeable",
  merge_status: "can_be_merged",
  has_conflicts: false,
  references: { full: `${PROJECT}!7` },
  head_pipeline: { id: 99, status: "running" },
};

function fakeClient(): { client: GitLabClient; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record =
    <T>(name: string, result: T) =>
    async (input?: unknown): Promise<T> => {
      (calls[name] ??= []).push(input);
      return result;
    };
  const pipeline = { id: 99, status: "running", jobs: [] };
  const client = {
    resolveProject: record("resolveProject", PROJECT),
    currentUser: record("currentUser", { id: 1, username: "me" }),
    getMergeRequest: record("getMergeRequest", mergeRequest),
    listMergeRequests: record("listMergeRequests", [mergeRequest]),
    listDiscussions: record("listDiscussions", [
      {
        id: "d1",
        notes: [
          { id: 1, body: "hi", created_at: "2026-01-01T00:00:00Z", author: { username: "a" } },
        ],
      },
    ]),
    getApprovals: record("getApprovals", { approvals_required: 1, approvals_left: 1 }),
    getLatestMrPipelineWithJobs: record("getLatestMrPipelineWithJobs", pipeline),
    getPipelineWithJobs: record("getPipelineWithJobs", pipeline),
    listIssues: record("listIssues", [
      {
        iid: 3,
        title: "Bug",
        web_url: "https://gitlab.example.com/group/sub/app/-/issues/3",
        state: "opened",
      },
    ]),
    createMergeRequest: record("createMergeRequest", {
      iid: 8,
      webUrl: "https://gitlab.example.com/group/sub/app/-/merge_requests/8",
    }),
    merge: record("merge", undefined),
    setSquash: record("setSquash", undefined),
    cancelAutoMerge: record("cancelAutoMerge", undefined),
    searchProjects: record("searchProjects", []),
  } as unknown as GitLabClient;
  return { client, calls };
}

function setup() {
  const { client, calls } = fakeClient();
  const service = createGitLabService({
    runner: createGlabCompatRunner(client),
    resolveGlabPath: async () => "python-gitlab",
    resolveRemoteUrl: async () => `git@gitlab.example.com:${PROJECT}.git`,
  });
  return { service, calls };
}

const cwd = "/work/app";

describe("glab-compatible runner behind upstream's GitLab service", () => {
  it("reports authentication through the current user", async () => {
    const { service, calls } = setup();
    expect(await service.isAuthenticated({ cwd })).toBe(true);
    expect(calls.currentUser).toHaveLength(1);
  });

  it("resolves the MR for a branch with its approvals and pipeline", async () => {
    const { service, calls } = setup();
    const status = await service.getCurrentPullRequestStatus({
      cwd,
      headRef: "feature",
      headSha: "abc123",
    });
    expect(status?.number).toBe(7);
    expect(calls.listMergeRequests?.[0]).toMatchObject({
      sourceBranch: "feature",
      project: PROJECT,
    });
    expect(calls.listMergeRequests?.[0]).not.toHaveProperty("state");
    expect(calls.getMergeRequest?.[0]).toMatchObject({ iid: 7 });
    expect(calls.getApprovals?.[0]).toMatchObject({ project: PROJECT, iid: 7 });
    expect(calls.getLatestMrPipelineWithJobs?.[0]).toMatchObject({ iid: 7 });
  });

  it("lists open merge requests and issues with search and limit", async () => {
    const { service, calls } = setup();
    expect(await service.listPullRequests({ cwd, query: "thing", limit: 5 })).toHaveLength(1);
    expect(calls.listMergeRequests?.[0]).toMatchObject({
      state: "opened",
      search: "thing",
      limit: 5,
    });
    expect(await service.listIssues({ cwd, query: "bug", limit: 4 })).toHaveLength(1);
    expect(calls.listIssues?.[0]).toMatchObject({ search: "bug", limit: 4, project: PROJECT });
  });

  it("creates a merge request and reads the number from the URL", async () => {
    const { service, calls } = setup();
    const created = await service.createPullRequest({
      cwd,
      title: "T",
      body: "B",
      head: "feature",
      base: "main",
    });
    expect(created).toEqual({
      url: "https://gitlab.example.com/group/sub/app/-/merge_requests/8",
      number: 8,
    });
    expect(calls.createMergeRequest?.[0]).toMatchObject({
      title: "T",
      description: "B",
      sourceBranch: "feature",
      targetBranch: "main",
    });
  });

  it("merges directly, squashing first when asked", async () => {
    const { service, calls } = setup();
    const status = await service.getCurrentPullRequestStatus({ cwd, headRef: "feature" });
    await service.mergePullRequest({ cwd, prNumber: 7, mergeMethod: "squash", status } as never);
    expect(calls.setSquash?.[0]).toMatchObject({ iid: 7, squash: true });
    expect(calls.merge?.[0]).toMatchObject({ iid: 7, whenPipelineSucceeds: false });
  });

  it("refuses a rebase merge", async () => {
    const { service } = setup();
    const status = await service.getCurrentPullRequestStatus({ cwd, headRef: "feature" });
    await expect(
      service.mergePullRequest({ cwd, prNumber: 7, mergeMethod: "rebase", status } as never),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/Rebase merge is not supported/),
    });
  });

  it("schedules and cancels auto-merge", async () => {
    const { service, calls } = setup();
    const status = await service.getCurrentPullRequestStatus({ cwd, headRef: "feature" });
    await service.enablePullRequestAutoMerge({
      cwd,
      prNumber: 7,
      mergeMethod: "merge",
      status,
    } as never);
    expect(calls.merge?.[0]).toMatchObject({ iid: 7, whenPipelineSucceeds: true });
    await service.disablePullRequestAutoMerge({ cwd, prNumber: 7 });
    expect(calls.cancelAutoMerge?.[0]).toMatchObject({ project: PROJECT, iid: 7 });
  });

  it("loads check details by merge request number or pipeline id", async () => {
    const { service, calls } = setup();
    await service.getCheckDetails({ cwd, changeRequestNumber: 7, checkRunId: 99 } as never);
    expect(calls.getLatestMrPipelineWithJobs?.[0]).toMatchObject({ iid: 7 });
    await service.getCheckDetails({ cwd, checkRunId: 99 } as never);
    expect(calls.getPipelineWithJobs?.[0]).toMatchObject({ pipelineId: 99 });
  });

  it("loads the discussion timeline", async () => {
    const { service, calls } = setup();
    const timeline = await service.getPullRequestTimeline({
      cwd,
      prNumber: 7,
      repoOwner: "group/sub",
      repoName: "app",
    });
    expect(timeline.error).toBeNull();
    expect(timeline.items).toHaveLength(1);
    expect(calls.listDiscussions?.[0]).toMatchObject({ project: PROJECT, iid: 7, perPage: 100 });
  });

  it("fails loudly on a command line it does not know", async () => {
    const run = createGlabCompatRunner(fakeClient().client);
    await expect(run(["repo", "view"], { cwd })).rejects.toThrow(/Unsupported glab command/);
    await expect(run(["api", "user"], { cwd })).rejects.toThrow(/Unsupported GitLab API/);
  });

  it("passes python-gitlab's message through as stderr", async () => {
    const { client } = fakeClient();
    client.currentUser = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("boom"), { stderr: "Impossible to get (401: 401 Unauthorized)" }),
      );
    const service = createGitLabService({
      runner: createGlabCompatRunner(client),
      resolveGlabPath: async () => "python-gitlab",
      resolveRemoteUrl: async () => `git@gitlab.example.com:${PROJECT}.git`,
    });
    expect(await service.isAuthenticated({ cwd })).toBe(false);
  });
});
