import { execFile } from "node:child_process";
import { z } from "zod";
import type { GitLabProject } from "../shared/rpc.js";
import type { GitLabSettings } from "./config.js";

const TIMEOUT_MS = 30_000;

const ProjectRowSchema = z
  .object({
    path_with_namespace: z.string(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    web_url: z.string().nullable().optional(),
    last_activity_at: z.string().nullable().optional(),
    namespace: z.object({ kind: z.string().optional() }).passthrough().nullable().optional(),
    forked_from_project: z
      .object({ path_with_namespace: z.string().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

function namespaceKind(row: z.infer<typeof ProjectRowSchema>): "group" | "user" | null {
  const kind = row.namespace?.kind;
  return kind === "group" || kind === "user" ? kind : null;
}

/** A leading `@` makes python-gitlab read the value from a file; doubling it escapes that. */
function cliValue(value: string): string {
  return value.startsWith("@") ? `@${value}` : value;
}

function option(name: string, value: string | number | boolean): string {
  return `--${name}=${cliValue(String(value))}`;
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error(
              `\`${file}\` not found; install python-gitlab: uv tool install python-gitlab`,
            ),
          );
          return;
        }
        reject(new Error(stderr.trim() || error.message));
      },
    );
  });
}

function globalArgs(settings: GitLabSettings): string[] {
  return [
    "--output=json",
    "--skip-login",
    `--server-url=${settings.url}`,
    ...(settings.configSection ? [`--gitlab=${settings.configSection}`] : []),
  ];
}

/** Runs one python-gitlab command and returns its stdout. */
function gitlab(settings: GitLabSettings, args: string[]): Promise<string> {
  const [file = "gitlab", ...prefix] = settings.command;
  return run(file, [...prefix, ...globalArgs(settings), ...args]);
}

export interface SearchOptions {
  /** The signed-in user's name, to tell their own projects from other people's. */
  username?: string | null;
}

/** Fork is for projects that are not the user's own; without a username, for team projects only. */
export function canFork(
  path: string,
  kind: "group" | "user" | null,
  username: string | null | undefined,
): boolean {
  if (username) return !path.startsWith(`${username}/`);
  return kind === "group";
}

export async function searchProjects(
  settings: GitLabSettings,
  query: string,
  limit: number,
  options: SearchOptions = {},
): Promise<GitLabProject[]> {
  const trimmed = query.trim();
  // Not `--simple`: the full record says whether a project belongs to a group and what it forks.
  const stdout = await gitlab(settings, [
    "project",
    "list",
    option("membership", true),
    option("order-by", "last_activity_at"),
    option("sort", "desc"),
    option("per-page", limit),
    "--no-get-all",
    ...(trimmed ? [option("search", trimmed)] : []),
  ]);
  return z
    .array(ProjectRowSchema)
    .parse(JSON.parse(stdout))
    .map((row) => ({
      path: row.path_with_namespace,
      name: row.name ?? row.path_with_namespace.split("/").at(-1) ?? row.path_with_namespace,
      description: row.description ?? null,
      webUrl: row.web_url ?? null,
      lastActivityAt: row.last_activity_at ?? null,
      namespaceKind: namespaceKind(row),
      forkedFrom: row.forked_from_project?.path_with_namespace ?? null,
      canFork: canFork(row.path_with_namespace, namespaceKind(row), options.username),
    }));
}

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;

/** `group/sub/project`, each segment a plain name: no `..`, no leading dash, no empty parts. */
export function assertProjectPath(path: string): void {
  const segments = path.split("/");
  if (
    segments.length < 2 ||
    !segments.every((segment) => SEGMENT.test(segment) && segment !== "..")
  ) {
    throw new Error("Project path must look like group/project");
  }
}

export function cloneUrl(settings: GitLabSettings, path: string): string {
  assertProjectPath(path);
  if (!settings.sshHost) {
    return `${settings.url}/${path}.git`;
  }
  const [host = "", port] = settings.sshHost.split(":");
  return port ? `ssh://git@${host}:${port}/${path}.git` : `git@${host}:${path}.git`;
}

export async function gitClone(url: string, directory: string): Promise<void> {
  await run("git", ["clone", "--", url, directory], { GIT_TERMINAL_PROMPT: "0" });
}

export async function remoteOf(directory: string): Promise<string | null> {
  try {
    return (await run("git", ["-C", directory, "remote", "get-url", "origin"])).trim();
  } catch {
    return null;
  }
}

const ForkProjectSchema = ProjectRowSchema.extend({
  import_status: z.string().nullable().optional(),
  import_error: z.string().nullable().optional(),
});

export interface ProjectInfo {
  path: string;
  forkedFrom: string | null;
  /** `null` once the repository is ready to clone. */
  importing: string | null;
  importError: string | null;
}

function toProjectInfo(raw: unknown): ProjectInfo {
  const row = ForkProjectSchema.parse(raw);
  // A fork's repository is built in the background; until it finishes there is nothing to clone.
  const status = row.import_status ?? "none";
  return {
    path: row.path_with_namespace,
    forkedFrom: row.forked_from_project?.path_with_namespace ?? null,
    importing: status === "finished" || status === "none" ? null : status,
    importError: row.import_error ?? null,
  };
}

export async function currentUsername(settings: GitLabSettings): Promise<string> {
  const user = z
    .object({ username: z.string() })
    .passthrough()
    .parse(JSON.parse(await gitlab(settings, ["current-user", "get"])));
  return user.username;
}

/** The project at `path`, or null when GitLab says it does not exist (or is not visible). */
export async function getProject(
  settings: GitLabSettings,
  path: string,
): Promise<ProjectInfo | null> {
  assertProjectPath(path);
  try {
    return toProjectInfo(
      JSON.parse(await gitlab(settings, ["project", "get", option("id", path)])),
    );
  } catch (error) {
    if (/\b404\b|not found/iu.test((error as Error).message)) return null;
    throw error;
  }
}

/** Forks `path` into the user's own namespace. GitLab answers before the fork's repository exists. */
export async function forkProject(settings: GitLabSettings, path: string): Promise<ProjectInfo> {
  assertProjectPath(path);
  const stdout = await gitlab(settings, ["project-fork", "create", option("project-id", path)]);
  return toProjectInfo(JSON.parse(stdout));
}

/** Adds `name` -> `url` unless the remote already exists. Returns whether it was added. */
export async function addRemote(directory: string, name: string, url: string): Promise<boolean> {
  try {
    await run("git", ["-C", directory, "remote", "get-url", name]);
    return false;
  } catch {
    await run("git", ["-C", directory, "remote", "add", name, url]);
    return true;
  }
}
