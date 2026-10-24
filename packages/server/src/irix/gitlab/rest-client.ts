// Irix: GitLab through its REST API with gitbeaker (@gitbeaker/rest), in the daemon's own
// process: no `gitlab` or `glab` executable and no process start per call. The token comes from the
// team's python-gitlab config (`credentials.ts`); the TLS trust is Node's plus the system store
// (`system-ca.ts`). Every response is parsed with the zod schemas in `schemas.ts`, so a change in
// GitLab's shape fails loudly where it is read.
//
// New GitLab features for agents go here: add a method to `GitLabClient` and call `api()`; gitbeaker
// already covers the rest of the REST API.

import { Gitlab } from "@gitbeaker/rest";
import { z } from "zod";
import { allowEgressHost } from "../egress-guard.js";
import { GitLabApiError, type GitLabClient, type MergeRequestScope } from "./client.js";
import { parseGitLabProjectPath, type GitLabForgeConfig } from "./config.js";
import { forkPairOf, readRemoteUrls, type RemoteReader } from "./fork-scope.js";
import { defaultUpstreamCaches, type UpstreamCaches } from "./upstream-cache.js";
import {
  GitLabCredentialsError,
  resolveGitLabCredentials,
  type GitLabCredentials,
} from "./credentials.js";
import {
  GitLabApprovalsSchema,
  GitLabCurrentUserSchema,
  GitLabDiscussionSchema,
  GitLabIssueSchema,
  GitLabMergeRequestSchema,
  GitLabMrPipelineSummarySchema,
  GitLabPipelineDetailsSchema,
  GitLabPipelineJobSchema,
  GitLabProjectSchema,
  type GitLabMergeRequest,
  type GitLabProject,
  type GitLabPipelineDetails,
  type GitLabPipelineJob,
} from "./schemas.js";
import { installSystemCa } from "./system-ca.js";

const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_CACHE_MS = 5 * 60_000;

const CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export interface GitLabRestClientOptions {
  config: GitLabForgeConfig;
  /** Test seam: the URL of `origin`, in place of reading it from git (no `upstream` is then seen). */
  resolveRemoteUrl?: (cwd: string) => Promise<string | null>;
  /** Test seam: replaces reading a remote's URL from git. */
  readRemote?: RemoteReader;
  /** Test seam: what tells the cached remotes of a checkout are out of date (null: never cache). */
  fingerprint?: (cwd: string) => Promise<string | null>;
  /** Test seam: fresh caches instead of the daemon-wide ones. */
  caches?: UpstreamCaches;
  /** Test seam: replaces the lookup of the python-gitlab config and environment. */
  resolveCredentials?: () => Promise<GitLabCredentials>;
}

interface FailureCause {
  description?: unknown;
  response?: { status?: unknown };
  code?: unknown;
  message?: unknown;
}

function describeHttpFailure(
  error: unknown,
  cause: FailureCause | undefined,
): GitLabApiError | null {
  const status = cause?.response?.status;
  if (typeof status !== "number") return null;
  const description =
    typeof cause?.description === "string" && cause.description
      ? cause.description
      : ((error as Error).message ?? "");
  return new GitLabApiError(`GitLab API error (${status}): ${description}`, status);
}

function describeTransportFailure(error: unknown, cause: FailureCause | undefined): GitLabApiError {
  if ((error as Error | null)?.name === "GitbeakerTimeoutError") {
    return new GitLabApiError(`GitLab did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`);
  }
  const code = typeof cause?.code === "string" ? cause.code : null;
  if (code && CERTIFICATE_CODES.has(code)) {
    return new GitLabApiError(
      `Cannot verify GitLab's certificate (${code}). Install the company CA in the system ` +
        "certificate store, set NODE_EXTRA_CA_CERTS to its PEM file, or point `ssl_verify` " +
        "in the python-gitlab config at it",
    );
  }
  const detail = typeof cause?.message === "string" ? cause.message : (error as Error).message;
  return new GitLabApiError(`Cannot reach GitLab${code ? ` (${code})` : ""}: ${detail}`);
}

/** The status gitbeaker saw, and GitLab's own description of the failure. */
function describeFailure(error: unknown): GitLabApiError {
  if (error instanceof GitLabApiError) return error;
  if (error instanceof GitLabCredentialsError) return new GitLabApiError(error.stderr, 401);
  const cause = (error as { cause?: unknown } | null)?.cause as FailureCause | undefined;
  return describeHttpFailure(error, cause) ?? describeTransportFailure(error, cause);
}

function newestFirst<T extends { id: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.id - a.id);
}

/**
 * GitLab is replacing `merge_when_pipeline_succeeds` with `auto_merge_enabled`.
 * Prefer the new field when the response carries it, and keep exposing the
 * value under the name the adapter reads.
 */
function normalizeMergeRequest(mr: GitLabMergeRequest): GitLabMergeRequest {
  if (mr.auto_merge_enabled === undefined) {
    return mr;
  }
  return { ...mr, merge_when_pipeline_succeeds: mr.auto_merge_enabled };
}

export function createGitLabRestClient(options: GitLabRestClientOptions): GitLabClient {
  const { config } = options;
  const caches = options.caches ?? defaultUpstreamCaches;
  const readOrigin = options.resolveRemoteUrl;
  const readRemote: RemoteReader | undefined =
    options.readRemote ??
    (readOrigin
      ? (cwd, remote) => (remote === "origin" ? readOrigin(cwd) : Promise.resolve(null))
      : undefined);
  const remoteUrls = (cwd: string) =>
    readRemoteUrls({ cwd, read: readRemote, fingerprint: options.fingerprint, caches });
  const loadCredentials =
    options.resolveCredentials ??
    (() => resolveGitLabCredentials({ section: config.configSection }));

  let cached: { at: number; api: InstanceType<typeof Gitlab> } | null = null;

  async function api(): Promise<InstanceType<typeof Gitlab>> {
    if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.api;
    // The configured GitLab is the one server this edition talks to; the egress guard needs to know.
    allowEgressHost(new URL(config.url).hostname);
    const credentials = await loadCredentials();
    installSystemCa({ extraFiles: credentials.caFile ? [credentials.caFile] : [] });
    const common = { host: config.url, queryTimeout: REQUEST_TIMEOUT_MS };
    const tokenOption = { private: "token", oauth: "oauthToken", job: "jobToken" }[
      credentials.kind
    ];
    const created = new Gitlab({ ...common, [tokenOption]: credentials.token });
    cached = { at: Date.now(), api: created };
    return created;
  }

  /** Runs one call; a failure becomes a GitLabApiError, and a rejected token is looked up again. */
  async function call<T>(
    operation: (gitlab: InstanceType<typeof Gitlab>) => Promise<unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      return schema.parse(await operation(await api()));
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new GitLabApiError(`GitLab returned an unexpected response: ${error.message}`);
      }
      const failure = describeFailure(error);
      if (failure.status === 401) cached = null;
      throw failure;
    }
  }

  const Anything = z.unknown();

  async function listJobs(project: string, pipelineId: number): Promise<GitLabPipelineJob[]> {
    return call(
      (gitlab) => gitlab.Jobs.all(project, { pipelineId, perPage: 100 }),
      z.array(GitLabPipelineJobSchema),
    );
  }

  return {
    async resolveProject(cwd) {
      const { origin } = await remoteUrls(cwd);
      const project = origin ? parseGitLabProjectPath(config, origin) : null;
      if (!project) {
        throw new GitLabApiError(
          `The origin remote of ${cwd} does not belong to the configured GitLab (${config.url})`,
        );
      }
      return project;
    },

    async resolveMergeRequestScope(cwd): Promise<MergeRequestScope> {
      const urls = await remoteUrls(cwd);
      const pair = forkPairOf(config, urls);
      if (!pair) {
        return { project: await this.resolveProject(cwd), sourceProjectId: null };
      }
      // The same cached lookup the Create button uses (upstream-merge-request.ts).
      const source = (await caches.projects.get(`${config.url}|${pair.originPath}`, "project", () =>
        call((gitlab) => gitlab.Projects.show(pair.originPath), GitLabProjectSchema),
      )) as GitLabProject;
      return { project: pair.upstreamPath, sourceProjectId: source.id };
    },

    currentUser() {
      return call((gitlab) => gitlab.Users.showCurrentUser(), GitLabCurrentUserSchema);
    },

    async getMergeRequest({ project, iid }) {
      return normalizeMergeRequest(
        await call((gitlab) => gitlab.MergeRequests.show(project, iid), GitLabMergeRequestSchema),
      );
    },

    async listMergeRequests(input) {
      const mergeRequests = await call(
        (gitlab) =>
          gitlab.MergeRequests.all({
            projectId: input.project,
            orderBy: "updated_at",
            sort: "desc",
            perPage: input.limit ?? 30,
            maxPages: 1,
            ...(input.sourceBranch !== undefined ? { sourceBranch: input.sourceBranch } : {}),
            ...(input.state ? { state: input.state } : {}),
            ...(input.search ? { search: input.search } : {}),
          }),
        z.array(GitLabMergeRequestSchema),
      );
      const own =
        input.sourceProjectId == null
          ? mergeRequests
          : mergeRequests.filter((mr) => mr.source_project_id === input.sourceProjectId);
      return own.map(normalizeMergeRequest);
    },

    listDiscussions(input) {
      return call(
        (gitlab) =>
          gitlab.MergeRequestDiscussions.all(input.project, input.iid, {
            perPage: input.perPage,
            maxPages: 1,
            ...(input.page !== undefined ? { page: input.page } : {}),
          }),
        z.array(GitLabDiscussionSchema),
      );
    },

    getApprovals({ project, iid }) {
      return call(
        (gitlab) =>
          gitlab.MergeRequestApprovals.showConfiguration(project, { mergerequestIId: iid }),
        GitLabApprovalsSchema,
      );
    },

    async getLatestMrPipelineWithJobs({ project, iid }) {
      const pipelines = await call(
        (gitlab) => gitlab.MergeRequests.allPipelines(project, iid, { perPage: 20, maxPages: 1 }),
        z.array(GitLabMrPipelineSummarySchema),
      );
      const latest = newestFirst(pipelines)[0];
      if (!latest) {
        return null;
      }
      // A fork or detached MR pipeline lives in its own project, so the jobs
      // are read from the project the pipeline reports.
      const jobs = await listJobs(String(latest.project_id ?? project), latest.id);
      return GitLabPipelineDetailsSchema.parse({ ...latest, jobs });
    },

    async getPipelineWithJobs({ project, pipelineId }): Promise<GitLabPipelineDetails> {
      const pipeline = await call(
        (gitlab) => gitlab.Pipelines.show(project, pipelineId),
        GitLabMrPipelineSummarySchema,
      );
      const jobs = await listJobs(project, pipelineId);
      return GitLabPipelineDetailsSchema.parse({ ...pipeline, jobs });
    },

    getIssue({ project, iid }) {
      return call((gitlab) => gitlab.Issues.show(iid, { projectId: project }), GitLabIssueSchema);
    },

    listIssues(input) {
      return call(
        (gitlab) =>
          gitlab.Issues.all({
            projectId: input.project,
            orderBy: "updated_at",
            sort: "desc",
            state: input.state ?? "opened",
            perPage: input.limit ?? 30,
            maxPages: 1,
            ...(input.search ? { search: input.search } : {}),
          }),
        z.array(GitLabIssueSchema),
      );
    },

    async createMergeRequest(input) {
      const created = await call(
        (gitlab) =>
          gitlab.MergeRequests.create(
            input.project,
            input.sourceBranch,
            input.targetBranch,
            input.title,
            { description: input.description },
          ),
        z.object({ iid: z.number(), web_url: z.string() }).passthrough(),
      );
      return { iid: created.iid, webUrl: created.web_url };
    },

    async merge({ project, iid, whenPipelineSucceeds }) {
      // `merge_when_pipeline_succeeds` is deprecated for `auto_merge` (GitLab 17.11); an older
      // server ignores the new name and a newer one the old, so send both.
      await call(
        (gitlab) =>
          gitlab.MergeRequests.merge(
            project,
            iid,
            whenPipelineSucceeds ? { autoMerge: true, mergeWhenPipelineSucceeds: true } : {},
          ),
        Anything,
      );
    },

    async setSquash({ project, iid, squash }) {
      await call((gitlab) => gitlab.MergeRequests.edit(project, iid, { squash }), Anything);
    },

    async cancelAutoMerge({ project, iid }) {
      await call((gitlab) => gitlab.MergeRequests.cancelOnPipelineSuccess(project, iid), Anything);
    },

    getProject({ project }) {
      return call((gitlab) => gitlab.Projects.show(project), GitLabProjectSchema);
    },

    searchProjects(input) {
      return call(
        (gitlab) =>
          gitlab.Projects.all({
            membership: true,
            simple: true,
            orderBy: "last_activity_at",
            sort: "desc",
            perPage: input.limit ?? 20,
            maxPages: 1,
            ...(input.query ? { search: input.query } : {}),
          }),
        z.array(GitLabProjectSchema),
      );
    },
  };
}
