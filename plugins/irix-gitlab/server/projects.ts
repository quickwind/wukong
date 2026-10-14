import { mkdir, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { CloneResult, searchProjectsRpc, startCloneRpc } from "../shared/rpc.js";
import { expandHome, loadSettings, type GitLabSettings } from "./config.js";
import {
  addRemote,
  assertProjectPath,
  cloneUrl,
  currentUsername,
  forkProject,
  getProject,
  gitClone,
  remoteOf,
  searchProjects,
} from "./gitlab.js";

// Who is signed in changes rarely and costs a request; asking once per daemon run per server is plenty.
const usernames = new Map<string, Promise<string | null>>();

/** For tests: forget who was signed in. */
export function forgetUsernames(): void {
  usernames.clear();
}

function knownUsername(settings: GitLabSettings): Promise<string | null> {
  const key = `${settings.url}#${settings.configSection ?? ""}`;
  let known = usernames.get(key);
  if (!known) {
    known = currentUsername(settings).catch(() => {
      usernames.delete(key); // try again next time; Fork clone falls back to team projects only
      return null;
    });
    usernames.set(key, known);
  }
  return known;
}

export async function search({
  query,
  limit,
}: RpcInput<typeof searchProjectsRpc>): Promise<RpcOutput<typeof searchProjectsRpc>> {
  const settings = loadSettings();
  const username = await knownUsername(settings);
  return {
    cloneRoot: settings.cloneRoot,
    projects: await searchProjects(settings, query, limit ?? 30, { username }),
  };
}

function resolveParent(input: string | undefined, fallback: string): string {
  const value = input?.trim();
  if (!value) return fallback;
  const expanded = expandHome(value);
  if (!isAbsolute(expanded)) {
    throw new Error("The clone folder must be an absolute path");
  }
  return resolve(expanded);
}

/**
 * `git remote get-url` applies the user's `url.<base>.insteadOf` rewrites, so the stored URL may
 * be an ssh form of the https URL we cloned from. The project path at the end is what identifies it.
 */
function isCloneOf(remote: string | null, projectPath: string): boolean {
  const normalized = remote?.replace(/\/+$/u, "").replace(/\.git$/u, "") ?? "";
  return normalized.endsWith(`/${projectPath}`) || normalized.endsWith(`:${projectPath}`);
}

export interface CloneDeps {
  sleep?: (ms: number) => Promise<void>;
  /** How often to ask GitLab whether a new fork is ready. */
  pollIntervalMs?: number;
  /** How long to wait for a fork before giving up. */
  forkTimeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function waitUntilReady(
  settings: GitLabSettings,
  path: string,
  report: (step: string) => void,
  deps: CloneDeps,
): Promise<void> {
  const interval = deps.pollIntervalMs ?? 2000;
  const timeout = deps.forkTimeoutMs ?? 5 * 60 * 1000;
  const sleep = deps.sleep ?? defaultSleep;
  for (let waited = 0; waited <= timeout; waited += interval) {
    const info = await getProject(settings, path);
    if (!info) throw new Error(`${path} disappeared while GitLab was building it`);
    if (info.importing === null) return;
    if (info.importing === "failed") {
      throw new Error(info.importError ?? `GitLab could not build the fork ${path}`);
    }
    report("Waiting for GitLab to build your fork…");
    await sleep(interval);
  }
  throw new Error(`GitLab is still building ${path}; try again in a few minutes`);
}

/**
 * The user's own fork of `source`, created if they have none. Returns the fork's path once its
 * repository can be cloned. An existing fork is reused; a project with the fork's name that is
 * not a fork of `source` is left alone and reported.
 */
export async function ensureFork(
  settings: GitLabSettings,
  source: string,
  report: (step: string) => void,
  deps: CloneDeps = {},
): Promise<string> {
  assertProjectPath(source);
  const username = await currentUsername(settings);
  if (source.startsWith(`${username}/`)) {
    throw new Error(`${source} is already in your namespace; use Clone and open`);
  }
  const mine = `${username}/${source.split("/").at(-1)}`;
  const existing = await getProject(settings, mine);
  if (existing) {
    if (existing.forkedFrom !== source) {
      throw new Error(`${mine} already exists and is not a fork of ${source}`);
    }
    report("Using your existing fork…");
    await waitUntilReady(settings, mine, report, deps);
    return mine;
  }
  report("Forking into your namespace…");
  const created = await forkProject(settings, source);
  assertProjectPath(created.path);
  await waitUntilReady(settings, created.path, report, deps);
  return created.path;
}

/**
 * Clones a project, or with `fork` the user's fork of it, into the clone folder. A fork clone
 * gets an `upstream` remote pointing at the original. A folder that already holds the same
 * project is reused; an unrelated one is never written to.
 */
export async function runClone(
  input: RpcInput<typeof startCloneRpc>,
  report: (step: string) => void,
  deps: CloneDeps = {},
): Promise<CloneResult> {
  const settings = loadSettings();
  assertProjectPath(input.path);
  const forkedFrom = input.fork ? input.path : null;
  const clonedPath = forkedFrom ? await ensureFork(settings, input.path, report, deps) : input.path;

  const url = cloneUrl(settings, clonedPath);
  const parent = resolveParent(input.parentDirectory, settings.cloneRoot);
  const directory = join(parent, basename(clonedPath));

  const existing = await readdir(directory).catch(() => null);
  let alreadyCloned = false;
  if (existing && existing.length > 0) {
    if (!isCloneOf(await remoteOf(directory), clonedPath)) {
      throw new Error(`${directory} already exists and is not a clone of ${clonedPath}`);
    }
    alreadyCloned = true;
  } else {
    report("Cloning…");
    await mkdir(parent, { recursive: true });
    await gitClone(url, directory);
  }
  if (forkedFrom) await addRemote(directory, "upstream", cloneUrl(settings, forkedFrom));
  return { directory, alreadyCloned, clonedPath, forkedFrom };
}
