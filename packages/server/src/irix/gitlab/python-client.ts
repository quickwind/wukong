import { z } from "zod";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import {
  createCachedCliPathResolver,
  createForgeCliRunner,
  defaultResolveRemoteUrl,
  ForgeAuthenticationError,
  ForgeCliMissingError,
  ForgeCommandError,
  parseCliJsonOutput,
  type ForgeCliRunner,
  type ForgeCliRunnerFactory,
  type ForgeCommandFailureParams,
} from "../../services/forge-cli-command.js";
import {
  DEFAULT_GITLAB_COMMAND,
  parseGitLabProjectPath,
  type GitLabForgeConfig,
} from "./config.js";
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
  type GitLabApprovals,
  type GitLabCurrentUser,
  type GitLabDiscussion,
  type GitLabIssue,
  type GitLabMergeRequest,
  type GitLabPipelineDetails,
  type GitLabPipelineJob,
  type GitLabProject,
} from "./schemas.js";

// Irix: GitLab is reached through the python-gitlab CLI (`gitlab`),
// because the company cannot install `glab`. Paseo never sees the token:
// python-gitlab reads `~/.python-gitlab.cfg` (including `helper:` credential
// helpers) and `GITLAB_PRIVATE_TOKEN` from the daemon's environment, and the
// token is never placed on argv.
//
// What python-gitlab 8.6.0 does, read from its source (gitlab/cli.py,
// gitlab/v4/cli.py, gitlab/config.py, gitlab/utils.py) and confirmed against a
// local fake REST server:
//
// 1. `--project-id` takes a full path such as `group/sub/proj`: the CLI wraps
//    it in `gitlab.utils.EncodedId`, which URL-quotes it with safe="" so the
//    request goes to `/projects/group%2Fsub%2Fproj/...`.
// 2. `--server-url` combined with `-g <section>` still takes the token (and
//    `ssl_verify`) from that section. Gitlab.merge_config only lets the URL
//    option win over `config.url`; `_merge_auth` falls back to the section.
//    Without `-g`, the `[global] default` section supplies the token, so set
//    `forge.gitlab.configSection` when the default section is another server.
//    The section must still define `url`: GitlabConfigParser reads it first and
//    fails without it, even though the URL option then wins.
// 3. `-o json` prints `obj.attributes` (the raw REST object) for get and
//    create, the server's JSON for update/merge/cancel (custom actions return
//    the parsed response), and an array of attributes for list. Nothing is
//    printed when an action returns None, which parseCliJsonOutput reports as
//    invalid JSON.
// 4. Option values are passed through `_parse_value`: a value starting with
//    `@` is read from that file path, and `@@` escapes it. `cliValue` doubles
//    a leading `@` so a title or branch name can never read a local file.
// 5. Boolean options are sent as the strings "true"/"false" in the JSON body
//    or query; GitLab's API layer coerces them.
// 6. Failures: `get/list/create/update` print `Impossible to <verb> (<status>:
//    <message>)` and exit 1; custom actions such as `merge` raise, so stderr
//    ends with a traceback whose last line is `gitlab.exceptions.<Name>:
//    <status>: <message>`. parseGitLabHttpStatus reads both shapes.
// 7. `--skip-login` skips the extra authenticated `/user` call the CLI makes
//    before every command when a token is present.
// 8. `project-merge-request merge` exposes `--merge-when-pipeline-succeeds`
//    but no squash and no `auto_merge` option, so squash goes through a prior
//    `update --squash`, and auto-merge uses the one parameter the CLI offers.

const GITLAB_COMMAND_TIMEOUT_MS = 30_000;
const GITLAB_ENV = { GITLAB_DEBUG: "" } as const;
const CLI_INSTALL_HINT = "install with `uv tool install python-gitlab`";

export class GitLabCliMissingError extends ForgeCliMissingError {
  constructor(command: string = DEFAULT_GITLAB_COMMAND[0] ?? "gitlab") {
    super(`python-gitlab CLI \`${command}\` not found; ${CLI_INSTALL_HINT}`);
    this.name = "GitLabCliMissingError";
  }
}

export class GitLabAuthenticationError extends ForgeAuthenticationError {
  constructor(params: { stderr: string }) {
    super("GitLab authentication failed; check the python-gitlab token", params);
    this.name = "GitLabAuthenticationError";
  }
}

export class GitLabCommandError extends ForgeCommandError {
  constructor(params: ForgeCommandFailureParams) {
    super({ brand: "GitLab", binary: "gitlab" }, params);
    this.name = "GitLabCommandError";
  }
}

const HTTP_STATUS_PATTERNS = [/\((\d{3}): /u, /\bGitlab\w*Error: (\d{3}): /u];

/** HTTP status python-gitlab reports on stderr, or null when it reported none. */
export function parseGitLabHttpStatus(stderr: string): number | null {
  for (const pattern of HTTP_STATUS_PATTERNS) {
    const match = pattern.exec(stderr);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  return null;
}

export function isGitLabAuthFailureText(text: string): boolean {
  const status = parseGitLabHttpStatus(text);
  return status === 401 || status === 403 || /\bGitlabAuthenticationError\b/u.test(text);
}

/** Doubles a leading `@` so python-gitlab does not read the value from a file. */
function cliValue(value: string): string {
  return value.startsWith("@") ? `@${value}` : value;
}

/**
 * `--name=value` keeps a value that starts with `-` from being read as a flag
 * and lets an empty value through.
 */
function option(name: string, value: string | number | boolean): string {
  return `--${name}=${cliValue(String(value))}`;
}

export interface GitLabRunnerOptions {
  cwd: string;
  envOverlay?: Record<string, string>;
}

export interface GitLabPythonClientOptions {
  config: GitLabForgeConfig;
  /** Test seam: replaces the process runner. Receives the full argv without the executable. */
  runner?: ForgeCliRunner;
  /** Test seam: replaces executable lookup for the configured command. */
  resolveExecutable?: () => Promise<string | null>;
  resolveRemoteUrl?: (cwd: string) => Promise<string | null>;
}

interface ProjectScope {
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

const JsonObjectSchema = z.record(z.string(), z.unknown());

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

function newestFirst<T extends { id: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.id - a.id);
}

export function createGitLabPythonClient(options: GitLabPythonClientOptions): GitLabClient {
  const { config } = options;
  const command = config.command ?? [...DEFAULT_GITLAB_COMMAND];
  const executable = command[0] ?? "gitlab";
  const commandPrefix = command.slice(1);
  const resolveRemoteUrl = options.resolveRemoteUrl ?? defaultResolveRemoteUrl;
  const resolveExecutable = createCachedCliPathResolver(
    options.resolveExecutable ?? (() => findExecutable(executable)),
  );

  const globalArgs = [
    ...commandPrefix,
    "--output=json",
    "--skip-login",
    `--server-url=${config.url}`,
    ...(config.configSection ? [`--gitlab=${config.configSection}`] : []),
  ];

  function buildRunner(binary: string): ForgeCliRunnerFactory {
    return createForgeCliRunner({
      binary,
      envOverlay: GITLAB_ENV,
      timeoutMs: GITLAB_COMMAND_TIMEOUT_MS,
      isAuthFailureText: isGitLabAuthFailureText,
      errorClasses: {
        isAlreadyClassified: (candidate) =>
          candidate instanceof GitLabAuthenticationError ||
          candidate instanceof GitLabCliMissingError,
        isCommandError: (candidate): candidate is GitLabCommandError =>
          candidate instanceof GitLabCommandError,
        createAuthError: (stderr) => new GitLabAuthenticationError({ stderr }),
        createMissingError: () => new GitLabCliMissingError(executable),
        createCommandError: (params) => new GitLabCommandError(params),
      },
    });
  }

  const runnerByPath = new Map<string, ForgeCliRunnerFactory>();
  const injectedRunner = options.runner ? buildRunner(executable) : null;

  async function run(args: string[], runOptions: GitLabRunnerOptions): Promise<string> {
    const fullArgs = [...globalArgs, ...args];
    const path = await resolveExecutable();
    if (!path) {
      throw new GitLabCliMissingError(executable);
    }
    let factory = injectedRunner;
    if (!factory) {
      factory = runnerByPath.get(path) ?? buildRunner(path);
      runnerByPath.set(path, factory);
    }
    try {
      const result = await (options.runner ?? factory.run)(fullArgs, runOptions);
      return result.stdout.trim();
    } catch (error) {
      throw factory.normalizeError(error, { args: fullArgs, cwd: runOptions.cwd });
    }
  }

  async function runJson<T>(
    args: string[],
    runOptions: GitLabRunnerOptions,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const stdout = await run(args, runOptions);
    return parseCliJsonOutput({
      commandName: "gitlab",
      args,
      cwd: runOptions.cwd,
      stdout,
      schema,
      createCommandError: (params) => new GitLabCommandError(params),
    });
  }

  function mergeRequestArgs(action: string, scope: ProjectScope, iid: number): string[] {
    return [
      "project-merge-request",
      action,
      option("project-id", scope.project),
      option("iid", iid),
    ];
  }

  async function listJobs(scope: ProjectScope, pipelineId: number): Promise<GitLabPipelineJob[]> {
    return runJson(
      [
        "project-pipeline-job",
        "list",
        option("project-id", scope.project),
        option("pipeline-id", pipelineId),
        option("per-page", 100),
        "--get-all",
      ],
      { cwd: scope.cwd },
      z.array(GitLabPipelineJobSchema),
    );
  }

  return {
    async resolveProject(cwd) {
      const remoteUrl = await resolveRemoteUrl(cwd);
      const project = remoteUrl ? parseGitLabProjectPath(config, remoteUrl) : null;
      if (!project) {
        throw new GitLabCommandError({
          args: [],
          cwd,
          exitCode: null,
          stderr: `The origin remote of ${cwd} does not belong to the configured GitLab (${config.url})`,
        });
      }
      return project;
    },

    currentUser(cwd) {
      return runJson(["current-user", "get"], { cwd }, GitLabCurrentUserSchema);
    },

    async getMergeRequest(input) {
      const mr = await runJson(
        mergeRequestArgs("get", input, input.iid),
        { cwd: input.cwd },
        GitLabMergeRequestSchema,
      );
      return normalizeMergeRequest(mr);
    },

    async listMergeRequests(input) {
      const args = [
        "project-merge-request",
        "list",
        option("project-id", input.project),
        option("order-by", "updated_at"),
        option("sort", "desc"),
        option("per-page", input.limit ?? 30),
        "--no-get-all",
      ];
      if (input.sourceBranch !== undefined) {
        args.push(option("source-branch", input.sourceBranch));
      }
      if (input.state) {
        args.push(option("state", input.state));
      }
      if (input.search) {
        args.push(option("search", input.search));
      }
      const mergeRequests = await runJson(
        args,
        { cwd: input.cwd },
        z.array(GitLabMergeRequestSchema),
      );
      return mergeRequests.map(normalizeMergeRequest);
    },

    listDiscussions(input) {
      return runJson(
        [
          "project-merge-request-discussion",
          "list",
          option("project-id", input.project),
          option("mr-iid", input.iid),
          ...(input.page !== undefined ? [option("page", input.page)] : []),
          option("per-page", input.perPage),
          "--no-get-all",
        ],
        { cwd: input.cwd },
        z.array(GitLabDiscussionSchema),
      );
    },

    getApprovals(input) {
      return runJson(
        [
          "project-merge-request-approval",
          "get",
          option("project-id", input.project),
          option("mr-iid", input.iid),
        ],
        { cwd: input.cwd },
        GitLabApprovalsSchema,
      );
    },

    async getLatestMrPipelineWithJobs(input) {
      const pipelines = await runJson(
        [
          "project-merge-request-pipeline",
          "list",
          option("project-id", input.project),
          option("mr-iid", input.iid),
          option("per-page", 20),
          "--no-get-all",
        ],
        { cwd: input.cwd },
        z.array(GitLabMrPipelineSummarySchema),
      );
      const latest = newestFirst(pipelines)[0];
      if (!latest) {
        return null;
      }
      // A fork or detached MR pipeline lives in its own project, so the jobs
      // are read from the project the pipeline reports.
      const jobs = await listJobs(
        { cwd: input.cwd, project: String(latest.project_id ?? input.project) },
        latest.id,
      );
      return GitLabPipelineDetailsSchema.parse({ ...latest, jobs });
    },

    async getPipelineWithJobs(input) {
      const pipeline = await runJson(
        [
          "project-pipeline",
          "get",
          option("project-id", input.project),
          option("id", input.pipelineId),
        ],
        { cwd: input.cwd },
        GitLabMrPipelineSummarySchema,
      );
      const jobs = await listJobs(input, input.pipelineId);
      return GitLabPipelineDetailsSchema.parse({ ...pipeline, jobs });
    },

    getIssue(input) {
      return runJson(
        ["project-issue", "get", option("project-id", input.project), option("iid", input.iid)],
        { cwd: input.cwd },
        GitLabIssueSchema,
      );
    },

    listIssues(input) {
      return runJson(
        [
          "project-issue",
          "list",
          option("project-id", input.project),
          option("order-by", "updated_at"),
          option("sort", "desc"),
          option("state", input.state ?? "opened"),
          option("per-page", input.limit ?? 30),
          "--no-get-all",
          ...(input.search ? [option("search", input.search)] : []),
        ],
        { cwd: input.cwd },
        z.array(GitLabIssueSchema),
      );
    },

    async createMergeRequest(input) {
      const created = await runJson(
        [
          "project-merge-request",
          "create",
          option("project-id", input.project),
          option("source-branch", input.sourceBranch),
          option("target-branch", input.targetBranch),
          option("title", input.title),
          option("description", input.description),
        ],
        { cwd: input.cwd },
        z.object({ iid: z.number(), web_url: z.string() }).passthrough(),
      );
      return { iid: created.iid, webUrl: created.web_url };
    },

    async merge(input) {
      await runJson(
        [
          ...mergeRequestArgs("merge", input, input.iid),
          ...(input.whenPipelineSucceeds ? [option("merge-when-pipeline-succeeds", true)] : []),
        ],
        { cwd: input.cwd },
        JsonObjectSchema,
      );
    },

    async setSquash(input) {
      await runJson(
        [...mergeRequestArgs("update", input, input.iid), option("squash", input.squash)],
        { cwd: input.cwd },
        JsonObjectSchema,
      );
    },

    async cancelAutoMerge(input) {
      await runJson(
        mergeRequestArgs("cancel-merge-when-pipeline-succeeds", input, input.iid),
        { cwd: input.cwd },
        JsonObjectSchema,
      );
    },

    searchProjects(input) {
      return runJson(
        [
          "project",
          "list",
          option("membership", true),
          option("simple", true),
          option("order-by", "last_activity_at"),
          option("sort", "desc"),
          option("per-page", input.limit ?? 20),
          "--no-get-all",
          ...(input.query ? [option("search", input.query)] : []),
        ],
        { cwd: input.cwd },
        z.array(GitLabProjectSchema),
      );
    },
  };
}
