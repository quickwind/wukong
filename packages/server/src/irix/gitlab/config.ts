import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { normalizeHost, parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";

// Irix: the company's self-hosted GitLab is the only forge. Its location comes from
// `irix.json` (or `wukong.json`) in the Irix/Paseo home (or IRIX_GITLAB_* / WUKONG_GITLAB_* variables),
// never from the checkout's remote, so a remote on any other host resolves to "no forge".

const SSH_HOST_PATTERN = /^([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?::(\d{1,5}))?$/iu;

function parseSshHost(value: string): { host: string; port?: string } | null {
  const match = SSH_HOST_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  const port = match[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
    return null;
  }
  return { host: normalizeHost(match[1] ?? ""), ...(port !== undefined ? { port } : {}) };
}

export const GitLabForgeConfigSchema = z
  .object({
    url: z
      .string()
      .trim()
      .superRefine((value, ctx) => {
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: `gitlab.url must be an https URL such as https://gitlab.example.com (got "${value}")`,
          });
          return;
        }
        if (parsed.protocol !== "https:") {
          ctx.addIssue({
            code: "custom",
            message: `gitlab.url must use https (got "${value}")`,
          });
        }
        if (parsed.username || parsed.password) {
          ctx.addIssue({
            code: "custom",
            message: "gitlab.url must not contain credentials; python-gitlab owns the token",
          });
        }
        if (parsed.search || parsed.hash) {
          ctx.addIssue({
            code: "custom",
            message: "gitlab.url must not contain a query string or fragment",
          });
        }
      }),
    sshHost: z
      .string()
      .trim()
      .refine((value) => parseSshHost(value) !== null, {
        message: 'gitlab.sshHost must be "host" or "host:port" with a port from 1 to 65535',
      })
      .optional(),
    configSection: z
      .string()
      .trim()
      .regex(/^[^\s-]\S*$/u, {
        message:
          "gitlab.configSection must be a python-gitlab section name without spaces or a leading dash",
      })
      .optional(),
    command: z
      .array(z.string().min(1, "gitlab.command entries must not be empty"))
      .min(1, "gitlab.command must name an executable")
      .optional(),
    // Read by the bundled GitLab plugin; accepted here so one wukong.json serves both.
    cloneRoot: z.string().trim().min(1).optional(),
  })
  .strict();

export type GitLabForgeConfig = z.infer<typeof GitLabForgeConfigSchema>;

export const DEFAULT_GITLAB_COMMAND: readonly string[] = ["gitlab"];

export interface GitLabForgeHosts {
  /** Web/API host from `url`. */
  webHost: string;
  /** Path prefix when GitLab is served under a sub-path, without slashes at the ends. */
  webPathPrefix: string;
  /** Host for SSH remotes, port-agnostic. Falls back to the web host. */
  sshHost: string;
  /** Explicit SSH port, when `sshHost` carries one. */
  sshPort?: string;
}

export function resolveGitLabForgeHosts(config: GitLabForgeConfig): GitLabForgeHosts {
  const url = new URL(config.url);
  const ssh = config.sshHost ? parseSshHost(config.sshHost) : null;
  return {
    webHost: normalizeHost(url.hostname),
    webPathPrefix: url.pathname.replace(/^\/+|\/+$/gu, ""),
    sshHost: ssh?.host ?? normalizeHost(url.hostname),
    ...(ssh?.port !== undefined ? { sshPort: ssh.port } : {}),
  };
}

/** True when `host` is the configured GitLab web host or its SSH host. */
export function matchesGitLabForgeHost(config: GitLabForgeConfig, host: string): boolean {
  const hosts = resolveGitLabForgeHosts(config);
  const normalized = normalizeHost(host);
  return normalized === hosts.webHost || normalized === hosts.sshHost;
}

/**
 * Project path (`group/sub/project`) of a checkout remote, or null when the
 * remote does not belong to the configured GitLab. Handles scp-style
 * (`git@host:group/sub/project.git`), `ssh://` with a port, and https remotes,
 * and strips the web path prefix of a GitLab served under a sub-path.
 */
export function parseGitLabProjectPath(
  config: GitLabForgeConfig,
  remoteUrl: string,
): string | null {
  const location = parseGitRemoteLocation(remoteUrl);
  if (!location || !matchesGitLabForgeHost(config, location.host)) {
    return null;
  }
  const { webPathPrefix } = resolveGitLabForgeHosts(config);
  let path = location.path;
  if (webPathPrefix && (location.transport === "https" || location.transport === "http")) {
    if (path === webPathPrefix || !path.startsWith(`${webPathPrefix}/`)) {
      return null;
    }
    path = path.slice(webPathPrefix.length + 1);
  }
  return path.length > 0 ? path : null;
}

import { existsSync } from "node:fs";

/**
 * Reads the GitLab location from `<home>/irix.json` (or `wukong.json`) (`{ "gitlab": { "url": ... } }`),
 * with IRIX_GITLAB_* / WUKONG_GITLAB_* taking precedence. Returns null
 * when no GitLab is configured, which leaves the edition with no forge at all.
 */
export function loadGitLabForgeConfig(
  paseoHome: string,
  env: NodeJS.ProcessEnv = process.env,
): GitLabForgeConfig | null {
  const irixPath = join(paseoHome, "irix.json");
  const wukongPath = join(paseoHome, "wukong.json");
  const filePath = existsSync(irixPath) ? irixPath : wukongPath;

  let fileConfig: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
    const gitlab = (parsed as { gitlab?: unknown } | null)?.gitlab;
    if (gitlab && typeof gitlab === "object") {
      fileConfig = gitlab as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot read ${filePath}: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  const command = (env.IRIX_GITLAB_COMMAND ?? env.WUKONG_GITLAB_COMMAND)?.trim();
  const url = env.IRIX_GITLAB_URL ?? env.WUKONG_GITLAB_URL;
  const sshHost = env.IRIX_GITLAB_SSH_HOST ?? env.WUKONG_GITLAB_SSH_HOST;
  const configSection = env.IRIX_GITLAB_SECTION ?? env.WUKONG_GITLAB_SECTION;

  const merged = {
    ...fileConfig,
    ...(url ? { url } : {}),
    ...(sshHost ? { sshHost } : {}),
    ...(configSection ? { configSection } : {}),
    ...(command ? { command: command.split(/\s+/u) } : {}),
  };
  if (!merged.url) {
    return null;
  }
  return GitLabForgeConfigSchema.parse(merged);
}
