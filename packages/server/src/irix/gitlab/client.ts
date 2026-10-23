// Irix: what the GitLab adapter needs from GitLab, and the errors it raises. `rest-client.ts`
// implements it over GitLab's REST API; `glab-runner.ts` and the contract tests only see this.

import type {
  GitLabApprovals,
  GitLabCurrentUser,
  GitLabDiscussion,
  GitLabIssue,
  GitLabMergeRequest,
  GitLabPipelineDetails,
  GitLabProject,
} from "./schemas.js";

/**
 * A failed GitLab request. `stderr` is what upstream's GitLab service reads to classify a failure
 * (it matches on the HTTP status and on words such as "unauthorized"), so keep the status in it.
 */
export class GitLabApiError extends Error {
  readonly code = 1;
  constructor(
    readonly stderr: string,
    /** HTTP status, or null when the request never got an answer. */
    readonly status: number | null = null,
  ) {
    super(stderr);
    this.name = "GitLabApiError";
  }
}

export interface ProjectScope {
  cwd: string;
  /** Full project path such as `group/sub/project`, or a numeric project id. */
  project: string;
}

export interface ListMergeRequestsInput extends ProjectScope {
  sourceBranch?: string;
  search?: string;
  /** Omit for every state. */
  state?: "opened" | "closed" | "merged";
  limit?: number;
}

export interface ListIssuesInput extends ProjectScope {
  search?: string;
  state?: "opened" | "closed";
  limit?: number;
}

export interface ListDiscussionsInput extends ProjectScope {
  iid: number;
  page?: number;
  perPage: number;
}

export interface CreateMergeRequestInput extends ProjectScope {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface MergeMergeRequestInput extends ProjectScope {
  iid: number;
  /** Schedule the merge for when the pipeline succeeds instead of merging now. */
  whenPipelineSucceeds?: boolean;
}

export interface SearchProjectsInput {
  cwd: string;
  query?: string;
  limit?: number;
}

export interface GitLabClient {
  /** Project path of the checkout's `origin`, resolved against the configured GitLab. */
  resolveProject(cwd: string): Promise<string>;
  currentUser(cwd: string): Promise<GitLabCurrentUser>;
  getMergeRequest(input: ProjectScope & { iid: number }): Promise<GitLabMergeRequest>;
  listMergeRequests(input: ListMergeRequestsInput): Promise<GitLabMergeRequest[]>;
  listDiscussions(input: ListDiscussionsInput): Promise<GitLabDiscussion[]>;
  getApprovals(input: ProjectScope & { iid: number }): Promise<GitLabApprovals>;
  /**
   * The merge request's newest pipeline with its jobs, shaped like the
   * `GitLabPipelineDetailsSchema` the adapter maps, or null when it has none.
   */
  getLatestMrPipelineWithJobs(
    input: ProjectScope & { iid: number },
  ): Promise<GitLabPipelineDetails | null>;
  getPipelineWithJobs(input: ProjectScope & { pipelineId: number }): Promise<GitLabPipelineDetails>;
  getIssue(input: ProjectScope & { iid: number }): Promise<GitLabIssue>;
  listIssues(input: ListIssuesInput): Promise<GitLabIssue[]>;
  createMergeRequest(input: CreateMergeRequestInput): Promise<{ iid: number; webUrl: string }>;
  merge(input: MergeMergeRequestInput): Promise<void>;
  setSquash(input: ProjectScope & { iid: number; squash: boolean }): Promise<void>;
  cancelAutoMerge(input: ProjectScope & { iid: number }): Promise<void>;
  searchProjects(input: SearchProjectsInput): Promise<GitLabProject[]>;
}
