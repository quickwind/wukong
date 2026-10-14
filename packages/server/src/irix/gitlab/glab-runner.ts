// Irix: answers the `glab` command lines that upstream's GitLab service issues, using the
// python-gitlab client. Upstream's service (status, checks, merge, issues, timeline) runs
// unchanged through its `runner` option, and no `glab` executable is involved, so a real glab
// installed on the same machine is never touched.
//
// Only the invocations upstream makes are translated. Any other command line fails loudly,
// which is what the contract tests in glab-runner.test.ts watch for after an upstream sync.

import type { GitLabClient } from "./python-client.js";

interface GlabCommandRunnerOptions {
  cwd: string;
}
type GlabCommandRunner = (
  args: string[],
  options: GlabCommandRunnerOptions,
) => Promise<{ stdout: string; stderr: string }>;

/** Value-taking flags among the ones upstream passes; everything else is a switch. */
const VALUE_FLAGS = new Set([
  "-F",
  "-O",
  "-P",
  "--source-branch",
  "--target-branch",
  "--order",
  "--sort",
  "--per-page",
  "--search",
  "--title",
  "--description",
  "--method",
  "--merge-request",
  "--pipeline-id",
  "--hostname",
]);

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (arg.startsWith("--") && equals !== -1) {
      flags.set(arg.slice(0, equals), arg.slice(equals + 1));
    } else if (VALUE_FLAGS.has(arg)) {
      flags.set(arg, args[index + 1] ?? "");
      index += 1;
    } else {
      flags.set(arg, "true");
    }
  }
  return { positionals, flags };
}

export class GlabCompatError extends Error {
  readonly code = 1;
  constructor(readonly stderr: string) {
    super(stderr);
    this.name = "GlabCompatError";
  }
}

function fail(message: string): never {
  throw new GlabCompatError(message);
}

function json(value: unknown): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify(value), stderr: "" };
}

function positiveInt(value: string | undefined, what: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`Expected a numeric ${what}, got "${value ?? ""}"`);
  }
  return parsed;
}

function optionalLimit(flags: Map<string, string>): number | undefined {
  const value = flags.get("-P") ?? flags.get("--per-page");
  return value === undefined ? undefined : positiveInt(value, "page size");
}

const API_PATH =
  /^projects\/([^/]+)\/merge_requests\/(\d+)\/(approvals|discussions|cancel_merge_when_pipeline_succeeds)(?:\?(.*))?$/u;

export function createGlabCompatRunner(client: GitLabClient): GlabCommandRunner {
  async function api(args: string[], cwd: string) {
    const { positionals, flags } = parseArgs(args.slice(1));
    const target = positionals[0] ?? "";
    const method = (flags.get("--method") ?? "GET").toUpperCase();
    // `:fullpath` is glab's placeholder for the project of the checkout in `cwd`.
    const resolved = target.replace(
      ":fullpath",
      encodeURIComponent(await client.resolveProject(cwd)),
    );
    const match = API_PATH.exec(resolved);
    if (!match) {
      fail(`Unsupported GitLab API request: ${method} ${target}`);
    }
    const project = decodeURIComponent(match[1] ?? "");
    const iid = Number(match[2]);
    const query = new URLSearchParams(match[4] ?? "");
    if (match[3] === "cancel_merge_when_pipeline_succeeds" && method === "POST") {
      await client.cancelAutoMerge({ cwd, project, iid });
      return json({});
    }
    if (method !== "GET") {
      fail(`Unsupported GitLab API request: ${method} ${target}`);
    }
    if (match[3] === "approvals") {
      return json(await client.getApprovals({ cwd, project, iid }));
    }
    const page = query.get("page");
    return json(
      await client.listDiscussions({
        cwd,
        project,
        iid,
        perPage: positiveInt(query.get("per_page") ?? "100", "page size"),
        ...(page ? { page: positiveInt(page, "page") } : {}),
      }),
    );
  }

  async function ciGet(flags: Map<string, string>, cwd: string) {
    const project = await client.resolveProject(cwd);
    const mergeRequest = flags.get("--merge-request");
    if (mergeRequest !== undefined) {
      const pipeline = await client.getLatestMrPipelineWithJobs({
        cwd,
        project,
        iid: positiveInt(mergeRequest, "merge request number"),
      });
      return pipeline
        ? json(pipeline)
        : fail(`No pipeline found for merge request ${mergeRequest}`);
    }
    const pipelineId = positiveInt(flags.get("--pipeline-id"), "pipeline id");
    return json(await client.getPipelineWithJobs({ cwd, project, pipelineId }));
  }

  async function mergeRequestCommand(args: string[], cwd: string) {
    const [, action, ...rest] = args;
    const { positionals, flags } = parseArgs(rest);
    if (action === "create") {
      const project = await client.resolveProject(cwd);
      const created = await client.createMergeRequest({
        cwd,
        project,
        title: flags.get("--title") ?? "",
        description: flags.get("--description") ?? "",
        sourceBranch: flags.get("--source-branch") ?? "",
        targetBranch: flags.get("--target-branch") ?? "",
      });
      return { stdout: `${created.webUrl}\n`, stderr: "" };
    }
    if (action === "view") {
      const project = await client.resolveProject(cwd);
      return json(
        await client.getMergeRequest({
          cwd,
          project,
          iid: positiveInt(positionals[0], "merge request number"),
        }),
      );
    }
    if (action === "list") {
      const project = await client.resolveProject(cwd);
      const sourceBranch = flags.get("--source-branch");
      const search = flags.get("--search");
      const limit = optionalLimit(flags);
      return json(
        await client.listMergeRequests({
          cwd,
          project,
          ...(flags.has("--all") ? {} : { state: "opened" as const }),
          ...(sourceBranch !== undefined ? { sourceBranch } : {}),
          ...(search ? { search } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
    }
    if (action === "merge") {
      if (flags.has("--rebase")) {
        fail("Rebase merge is not supported by the Irix GitLab adapter; use merge or squash");
      }
      const project = await client.resolveProject(cwd);
      const iid = positiveInt(positionals[0], "merge request number");
      if (flags.has("--squash")) {
        await client.setSquash({ cwd, project, iid, squash: true });
      }
      await client.merge({
        cwd,
        project,
        iid,
        whenPipelineSucceeds: flags.get("--auto-merge") === "true",
      });
      return { stdout: "", stderr: "" };
    }
    return fail(`Unsupported glab command: mr ${action ?? ""}`);
  }

  return async (args, { cwd }) => {
    const [command] = args;
    try {
      if (command === "mr") {
        return await mergeRequestCommand(args, cwd);
      }
      if (command === "api") {
        return await api(args, cwd);
      }
      if (command === "ci" && args[1] === "get") {
        return await ciGet(parseArgs(args.slice(2)).flags, cwd);
      }
      if (command === "issue" && args[1] === "list") {
        const { flags } = parseArgs(args.slice(2));
        const search = flags.get("--search");
        const limit = optionalLimit(flags);
        return json(
          await client.listIssues({
            cwd,
            project: await client.resolveProject(cwd),
            ...(search ? { search } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        );
      }
      if (command === "auth" && args[1] === "status") {
        await client.currentUser(cwd);
        return { stdout: "Logged in\n", stderr: "" };
      }
      return fail(`Unsupported glab command: ${args.join(" ")}`);
    } catch (error) {
      if (error instanceof GlabCompatError) {
        throw error;
      }
      // Carry python-gitlab's message (and HTTP status) as stderr so upstream classifies it.
      const stderr = (error as { stderr?: unknown }).stderr;
      const text = typeof stderr === "string" && stderr ? stderr : (error as Error).message;
      throw Object.assign(new Error(text), {
        stderr: text,
        code: 1,
      });
    }
  };
}
