import { describe, expect, it } from "vitest";

import {
  GitLabApprovalsSchema,
  GitLabCurrentUserSchema,
  GitLabDiscussionSchema,
  GitLabIssueSchema,
  GitLabMergeRequestSchema,
  GitLabMrPipelineSummarySchema,
  GitLabNotePositionSchema,
  GitLabNoteSchema,
  GitLabPipelineDetailsSchema,
  GitLabPipelineJobSchema,
  GitLabPipelineSchema,
  GitLabProjectSchema,
} from "./schemas.js";

const JOB = {
  id: 3001,
  name: "unit",
  stage: "test",
  status: "success",
  allow_failure: false,
  web_url: "https://gitlab.corp.example/team/app/-/jobs/3001",
  duration: 12.5,
};

const MERGE_REQUEST = {
  id: 9001,
  iid: 12,
  project_id: 555,
  title: "Add the thing",
  description: "Why",
  state: "opened",
  web_url: "https://gitlab.corp.example/team/app/-/merge_requests/12",
  source_branch: "feature/thing",
  target_branch: "main",
  source_project_id: 777,
  target_project_id: 555,
  sha: "0123456789abcdef0123456789abcdef01234567",
  draft: false,
  has_conflicts: false,
  blocking_discussions_resolved: true,
  auto_merge_enabled: false,
  detailed_merge_status: "mergeable",
  merged_at: null,
  labels: ["backend"],
  references: { short: "!12", full: "team/app!12" },
  head_pipeline: { id: 4001, status: "success", web_url: "https://gitlab.corp.example/x" },
};

const ISSUE = {
  id: 501,
  iid: 4,
  project_id: 555,
  title: "Crash on start",
  description: null,
  state: "opened",
  web_url: "https://gitlab.corp.example/team/app/-/issues/4",
  labels: ["bug"],
  updated_at: "2026-10-01T10:00:00.000Z",
  references: { short: "#4", full: "team/app#4" },
};

const NOTE = {
  id: 6001,
  type: "DiffNote",
  body: "Rename this",
  system: false,
  created_at: "2026-10-01T10:05:00.000Z",
  resolvable: true,
  resolved: false,
  author: {
    id: 7,
    username: "alice",
    name: "Alice",
    avatar_url: null,
    web_url: "https://gitlab.corp.example/alice",
  },
  position: {
    old_path: "src/a.ts",
    new_path: "src/a.ts",
    old_line: null,
    new_line: 10,
    line_range: { start: { new_line: 10, old_line: null }, end: { new_line: 12, old_line: null } },
  },
};

const DISCUSSION = {
  id: "6a9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c",
  individual_note: false,
  notes: [NOTE],
};

describe("GitLab REST payloads", () => {
  it.each<
    [
      string,
      { parse: (value: unknown) => unknown; safeParse: (value: unknown) => { success: boolean } },
      Record<string, unknown>,
      string[],
    ]
  >([
    ["pipeline job", GitLabPipelineJobSchema, JOB, ["id", "name", "stage", "status"]],
    [
      "pipeline with jobs",
      GitLabPipelineDetailsSchema,
      {
        id: 4001,
        status: "running",
        ref: "feature/thing",
        sha: "abc",
        web_url: "https://x",
        jobs: [JOB],
      },
      ["id", "status"],
    ],
    [
      "merge request",
      GitLabMergeRequestSchema,
      MERGE_REQUEST,
      ["iid", "title", "web_url", "state", "source_branch", "target_branch"],
    ],
    ["issue", GitLabIssueSchema, ISSUE, ["iid", "title", "web_url", "state"]],
    ["note", GitLabNoteSchema, NOTE, ["id"]],
    ["discussion", GitLabDiscussionSchema, DISCUSSION, ["id"]],
    [
      "merge request pipeline",
      GitLabMrPipelineSummarySchema,
      {
        id: 4001,
        project_id: 555,
        status: "success",
        ref: "feature/thing",
        sha: "abc",
        web_url: "https://x",
      },
      ["id", "status"],
    ],
    [
      "current user",
      GitLabCurrentUserSchema,
      { id: 7, username: "alice", name: "Alice", state: "active" },
      ["id", "username"],
    ],
    [
      "project",
      GitLabProjectSchema,
      {
        id: 555,
        path_with_namespace: "team/app",
        name: "app",
        description: null,
        default_branch: "main",
        web_url: "https://gitlab.corp.example/team/app",
        last_activity_at: "2026-10-01T10:00:00.000Z",
      },
      ["id", "path_with_namespace"],
    ],
  ])(
    "accepts a realistic %s and rejects one missing a required field",
    (_name, schema, payload, required) => {
      expect(schema.safeParse(payload).success).toBe(true);
      for (const key of required) {
        const { [key]: _removed, ...withoutKey } = payload;
        expect(schema.safeParse(withoutKey).success, `without ${key}`).toBe(false);
      }
    },
  );

  it("keeps fields it does not list, so a newer GitLab does not break the adapter", () => {
    const parsed = GitLabMergeRequestSchema.parse({ ...MERGE_REQUEST, some_new_field: true });
    expect(parsed).toMatchObject({ some_new_field: true });
  });

  it("rejects a merge request whose iid is not a number", () => {
    expect(GitLabMergeRequestSchema.safeParse({ ...MERGE_REQUEST, iid: "12" }).success).toBe(false);
  });

  it("fills in an empty job list for a pipeline that has none", () => {
    const parsed = GitLabPipelineDetailsSchema.parse({ id: 4001, status: "pending" });
    expect(parsed.jobs).toEqual([]);
  });

  it("fills in an empty note list for a discussion that has none", () => {
    expect(GitLabDiscussionSchema.parse({ id: "abc" }).notes).toEqual([]);
  });

  it("has no required field in the pipeline summary, approvals, note author and note position", () => {
    // These describe optional context; an empty object is a valid payload.
    expect(GitLabPipelineSchema.safeParse({}).success).toBe(true);
    expect(GitLabApprovalsSchema.safeParse({}).success).toBe(true);
    expect(GitLabNotePositionSchema.safeParse({}).success).toBe(true);
  });

  it("accepts an approvals payload with the approvers it lists", () => {
    expect(
      GitLabApprovalsSchema.safeParse({
        approvals_required: 1,
        approvals_left: 0,
        approved_by: [{ user: { id: 7, username: "alice" } }],
      }).success,
    ).toBe(true);
  });
});
