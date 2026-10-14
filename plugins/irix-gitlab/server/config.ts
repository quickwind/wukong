// Where the company GitLab is. Same sources as the daemon's forge adapter: `irix.json` (or legacy `wukong.json`) in the
// Paseo home (`{ "gitlab": { "url": ... } }`), with IRIX_GITLAB_* variables taking precedence.
// Kept separate from the adapter because a plugin bundle cannot import daemon modules.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface GitLabSettings {
  url: string;
  sshHost: string | null;
  configSection: string | null;
  command: string[];
  cloneRoot: string;
}

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  return /^~[\\/]/u.test(input) ? join(homedir(), input.slice(2)) : input;
}

function readFile(paseoHome: string): Record<string, unknown> {
  const irixPath = join(paseoHome, "irix.json");
  const wukongPath = join(paseoHome, "wukong.json");
  const filePath = existsSync(irixPath) ? irixPath : wukongPath;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
    const gitlab = (parsed as { gitlab?: unknown } | null)?.gitlab;
    return gitlab && typeof gitlab === "object" ? (gitlab as Record<string, unknown>) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read ${filePath}: ${(error as Error).message}`, { cause: error });
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): GitLabSettings {
  const paseoHome = resolve(expandHome(env.PASEO_HOME ?? "~/.paseo"));
  const file = readFile(paseoHome);
  const url = text(env.IRIX_GITLAB_URL) ?? text(env.WUKONG_GITLAB_URL) ?? text(file.url);
  if (!url) {
    throw new Error(
      'GitLab is not configured. Set "gitlab.url" in irix.json in the Paseo home, or IRIX_GITLAB_URL.',
    );
  }
  if (new URL(url).protocol !== "https:") {
    throw new Error("The GitLab URL must use https");
  }
  const command =
    text(env.IRIX_GITLAB_COMMAND)?.split(/\s+/u) ?? text(env.WUKONG_GITLAB_COMMAND)?.split(/\s+/u);
  const fileCommand = Array.isArray(file.command)
    ? file.command.filter((part): part is string => typeof part === "string" && part.length > 0)
    : [];
  return {
    url: url.replace(/\/+$/u, ""),
    sshHost:
      text(env.IRIX_GITLAB_SSH_HOST) ?? text(env.WUKONG_GITLAB_SSH_HOST) ?? text(file.sshHost),
    configSection:
      text(env.IRIX_GITLAB_SECTION) ?? text(env.WUKONG_GITLAB_SECTION) ?? text(file.configSection),
    command: command ?? (fileCommand.length > 0 ? fileCommand : ["gitlab"]),
    cloneRoot: resolve(
      expandHome(
        text(env.IRIX_CLONE_ROOT) ??
          text(env.WUKONG_CLONE_ROOT) ??
          text(file.cloneRoot) ??
          "~/projects",
      ),
    ),
  };
}
