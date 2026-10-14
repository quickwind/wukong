import { z } from "zod";

// REST shapes of the GitLab v4 API that the adapter consumes. python-gitlab
// prints the raw REST object (`obj.attributes`) as JSON, so these are the same
// shapes the API documents.

export const GitLabPipelineSchema = z
  .object({
    id: z.number().optional(),
    status: z.string().optional(),
    web_url: z.string().optional(),
  })
  .passthrough();

export const GitLabPipelineJobSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    stage: z.string(),
    status: z.string(),
    allow_failure: z.boolean().optional(),
    web_url: z.string().nullable().optional(),
    duration: z.number().nullable().optional(),
  })
  .passthrough();

export const GitLabPipelineDetailsSchema = z
  .object({
    id: z.number(),
    status: z.string(),
    ref: z.string().nullable().optional(),
    sha: z.string().nullable().optional(),
    web_url: z.string().nullable().optional(),
    jobs: z.array(GitLabPipelineJobSchema).optional().default([]),
  })
  .passthrough();

export const GitLabMergeRequestSchema = z
  .object({
    iid: z.number(),
    title: z.string(),
    web_url: z.string(),
    state: z.string(),
    source_branch: z.string(),
    target_branch: z.string(),
    sha: z.string().optional(),
    source_project_id: z.number().nullable().optional(),
    target_project_id: z.number().nullable().optional(),
    draft: z.boolean().optional(),
    work_in_progress: z.boolean().optional(),
    has_conflicts: z.boolean().optional(),
    blocking_discussions_resolved: z.boolean().optional(),
    // GitLab moves toward `auto_merge_enabled`; `merge_when_pipeline_succeeds` is
    // the deprecated spelling. The client folds the former into the latter, see
    // normalizeMergeRequest in gitlab-python-client.ts.
    merge_when_pipeline_succeeds: z.boolean().optional(),
    auto_merge_enabled: z.boolean().optional(),
    squash: z.boolean().optional(),
    approvals_required: z.number().nullable().optional(),
    approvals_given: z.number().nullable().optional(),
    merged_at: z.string().nullable().optional(),
    detailed_merge_status: z.string().optional(),
    merge_status: z.string().optional(),
    description: z.string().nullable().optional(),
    labels: z.array(z.string()).optional(),
    updated_at: z.string().optional(),
    references: z.object({ full: z.string().optional() }).passthrough().optional(),
    head_pipeline: GitLabPipelineSchema.nullable().optional(),
  })
  .passthrough();

export const GitLabIssueSchema = z
  .object({
    iid: z.number(),
    title: z.string(),
    web_url: z.string(),
    state: z.string(),
    description: z.string().nullable().optional(),
    labels: z.array(z.string()).optional(),
    updated_at: z.string().optional(),
    references: z.object({ full: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export const GitLabNoteAuthorSchema = z
  .object({
    username: z.string().optional(),
    name: z.string().optional(),
    web_url: z.string().nullable().optional(),
    avatar_url: z.string().nullable().optional(),
  })
  .passthrough();

export const GitLabNoteLineRangeEndpointSchema = z
  .object({
    new_line: z.number().nullable().optional(),
    old_line: z.number().nullable().optional(),
  })
  .passthrough();

export const GitLabNotePositionSchema = z
  .object({
    new_path: z.string().nullable().optional(),
    old_path: z.string().nullable().optional(),
    new_line: z.number().nullable().optional(),
    old_line: z.number().nullable().optional(),
    line_range: z
      .object({
        start: GitLabNoteLineRangeEndpointSchema.nullable().optional(),
        end: GitLabNoteLineRangeEndpointSchema.nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const GitLabNoteSchema = z
  .object({
    id: z.number(),
    body: z.string().nullable().optional(),
    system: z.boolean().optional(),
    type: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    resolvable: z.boolean().optional(),
    resolved: z.boolean().optional(),
    author: GitLabNoteAuthorSchema.nullable().optional(),
    position: GitLabNotePositionSchema.nullable().optional(),
  })
  .passthrough();

export const GitLabDiscussionSchema = z
  .object({
    id: z.string(),
    individual_note: z.boolean().optional(),
    notes: z.array(GitLabNoteSchema).optional().default([]),
  })
  .passthrough();

export const GitLabApprovalsSchema = z
  .object({
    approvals_required: z.number().nullable().optional(),
    approvals_left: z.number().nullable().optional(),
    approved_by: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();

export type GitLabMergeRequest = z.infer<typeof GitLabMergeRequestSchema>;
export type GitLabIssue = z.infer<typeof GitLabIssueSchema>;
export type GitLabNote = z.infer<typeof GitLabNoteSchema>;
export type GitLabNoteLineRangeEndpoint = z.infer<typeof GitLabNoteLineRangeEndpointSchema>;
export type GitLabDiscussion = z.infer<typeof GitLabDiscussionSchema>;
export type GitLabApprovals = z.infer<typeof GitLabApprovalsSchema>;

export const GitLabMrPipelineSummarySchema = z
  .object({
    id: z.number(),
    project_id: z.number().nullable().optional(),
    status: z.string(),
    ref: z.string().nullable().optional(),
    sha: z.string().nullable().optional(),
    web_url: z.string().nullable().optional(),
  })
  .passthrough();

export const GitLabCurrentUserSchema = z
  .object({
    id: z.number(),
    username: z.string(),
    name: z.string().optional(),
  })
  .passthrough();

export const GitLabProjectSchema = z
  .object({
    id: z.number(),
    path_with_namespace: z.string(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    web_url: z.string().optional(),
    default_branch: z.string().nullable().optional(),
    last_activity_at: z.string().nullable().optional(),
  })
  .passthrough();

export type GitLabMrPipelineSummary = z.infer<typeof GitLabMrPipelineSummarySchema>;
export type GitLabCurrentUser = z.infer<typeof GitLabCurrentUserSchema>;
export type GitLabProject = z.infer<typeof GitLabProjectSchema>;
export type GitLabPipelineDetails = z.infer<typeof GitLabPipelineDetailsSchema>;
export type GitLabPipelineJob = z.infer<typeof GitLabPipelineJobSchema>;
