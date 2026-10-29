/* oxlint-disable paseo/no-sync-io -- Irix: small config/credential reads outside the request path. */
// Irix: the team already has a python-gitlab config (`~/.python-gitlab.cfg`), so the REST client
// reads its token from there, the way python-gitlab does:
//
// - `GITLAB_PRIVATE_TOKEN`, `GITLAB_OAUTH_TOKEN` and `GITLAB_JOB_TOKEN` in the environment win.
// - Otherwise the section named by `forge.gitlab.configSection`, or `[global] default`, supplies
//   `private_token`, `oauth_token` or `job_token`. A value `helper: <command>` runs the command
//   (no shell) and uses its output, as python-gitlab does.
// - `PYTHON_GITLAB_CFG` replaces the file list; otherwise `/etc/python-gitlab.cfg` then
//   `~/.python-gitlab.cfg`, the later file winning.
// - `ssl_verify = /path/to/ca.pem` adds that CA to the daemon's trust. `ssl_verify = false` is not
//   honoured: the system CA store is the way to trust a company CA.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HELPER_TIMEOUT_MS = 10_000;

export type GitLabTokenKind = "private" | "oauth" | "job";

export interface GitLabCredentials {
  kind: GitLabTokenKind;
  token: string;
  /** PEM file named by `ssl_verify`, when the section gives a path. */
  caFile: string | null;
}

export class GitLabCredentialsError extends Error {
  readonly code = 1;
  constructor(readonly stderr: string) {
    super(stderr);
    this.name = "GitLabCredentialsError";
  }
}

type Cfg = Map<string, Map<string, string>>;

/** The INI dialect python-gitlab's configparser reads: `key = value` or `key: value`, `#`/`;` comments. */
export function parseCfg(text: string): Cfg {
  const cfg: Cfg = new Map();
  let current: Map<string, string> | null = null;
  for (const raw of text.replace(/^﻿/u, "").split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/u.exec(line);
    if (header) {
      current = cfg.get(header[1] ?? "") ?? new Map();
      cfg.set(header[1] ?? "", current);
      continue;
    }
    const pair = /^([^=:\s][^=:]*?)\s*[=:]\s*(.*)$/u.exec(line);
    if (current && pair) {
      current.set((pair[1] ?? "").toLowerCase(), pair[2] ?? "");
    }
  }
  return cfg;
}

function cfgFiles(env: NodeJS.ProcessEnv): string[] {
  const override = env.PYTHON_GITLAB_CFG?.trim();
  if (override) return [override];
  return ["/etc/python-gitlab.cfg", join(homedir(), ".python-gitlab.cfg")];
}

function readCfg(env: NodeJS.ProcessEnv): Cfg {
  const merged: Cfg = new Map();
  for (const file of cfgFiles(env)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new GitLabCredentialsError(
        `Cannot read ${file}: ${(error as Error).message}. Check the python-gitlab token`,
      );
    }
    for (const [section, values] of parseCfg(text)) {
      const target = merged.get(section) ?? new Map<string, string>();
      for (const [key, value] of values) target.set(key, value);
      merged.set(section, target);
    }
  }
  return merged;
}

/** Splits a helper command like python-gitlab's `shlex.split`: spaces separate, quotes group. */
function splitCommand(command: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  for (let match = pattern.exec(command); match; match = pattern.exec(command)) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return parts;
}

function expand(value: string, env: NodeJS.ProcessEnv): string {
  const home = homedir();
  return value
    .replace(/^~(?=$|[\\/])/u, home)
    .replace(
      /\$(\w+)|\$\{(\w+)\}|%(\w+)%/gu,
      (whole, a?: string, b?: string, c?: string) => env[a ?? b ?? c ?? ""] ?? whole,
    );
}

async function resolveValue(value: string, env: NodeJS.ProcessEnv): Promise<string> {
  const helper = /^helper:\s*(.+)$/u.exec(value);
  if (!helper) return value;
  const [file, ...args] = splitCommand(helper[1] ?? "").map((part) => expand(part, env));
  if (!file) throw new GitLabCredentialsError("The python-gitlab token helper is empty");
  try {
    const { stdout } = await execFileAsync(file, args, {
      timeout: HELPER_TIMEOUT_MS,
      windowsHide: true,
      env,
    });
    return stdout.trim();
  } catch (error) {
    throw new GitLabCredentialsError(
      `The python-gitlab token helper \`${file}\` failed: ${(error as Error).message}. ` +
        "Authentication failed; check the python-gitlab token",
    );
  }
}

export interface ResolveCredentialsOptions {
  /** `forge.gitlab.configSection`; without it, `[global] default`. */
  section?: string;
  env?: NodeJS.ProcessEnv;
}

export async function resolveGitLabCredentials(
  options: ResolveCredentialsOptions = {},
): Promise<GitLabCredentials> {
  const env = options.env ?? process.env;
  const cfg = readCfg(env);
  const sectionName = options.section ?? cfg.get("global")?.get("default");
  const section = sectionName ? cfg.get(sectionName) : undefined;

  const verify = section?.get("ssl_verify")?.trim();
  const caFile =
    verify && !/^(true|false|yes|no|on|off|1|0)$/iu.test(verify) ? expand(verify, env) : null;

  const fromEnv: Array<[GitLabTokenKind, string | undefined]> = [
    ["private", env.GITLAB_PRIVATE_TOKEN],
    ["oauth", env.GITLAB_OAUTH_TOKEN],
    ["job", env.GITLAB_JOB_TOKEN],
  ];
  for (const [kind, value] of fromEnv) {
    if (value?.trim()) return { kind, token: value.trim(), caFile };
  }

  const fromSection: Array<[GitLabTokenKind, string]> = [
    ["private", "private_token"],
    ["oauth", "oauth_token"],
    ["job", "job_token"],
  ];
  for (const [kind, key] of fromSection) {
    const value = section?.get(key);
    if (!value) continue;
    const token = await resolveValue(value, env);
    if (token) return { kind, token, caFile };
  }
  throw new GitLabCredentialsError(
    sectionName
      ? `Authentication failed: no token in section [${sectionName}] of the python-gitlab config`
      : "Authentication failed: no token found; set up GitLab in Irix or add a python-gitlab config",
  );
}
