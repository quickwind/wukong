// The plugin's way to GitLab: gitbeaker over REST, in the daemon's process. The token comes from
// the team's python-gitlab config (`credentials.ts`) and TLS trusts the system CA store
// (`system-ca.ts`). Both files are copies of the daemon's (`packages/server/src/irix/gitlab/`)
// because a plugin bundle cannot import daemon modules; a test in the server package keeps them
// identical.

import { Gitlab } from "@gitbeaker/rest";
import { GitLabCredentialsError, resolveGitLabCredentials } from "./credentials.js";
import { installSystemCa } from "./system-ca.js";

const REQUEST_TIMEOUT_MS = 30_000;
const CREDENTIALS_CACHE_MS = 5 * 60_000;

export type GitLabApi = InstanceType<typeof Gitlab>;

/** A failed request: the HTTP status when GitLab answered, null when it did not. */
export class GitLabRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "GitLabRequestError";
  }
}

const CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

interface FailureCause {
  description?: unknown;
  response?: { status?: unknown };
  code?: unknown;
  message?: unknown;
}

/** Turns what gitbeaker or `fetch` threw into an error that says what happened. */
export function describeRequestError(error: unknown): GitLabRequestError {
  if (error instanceof GitLabRequestError) return error;
  if (error instanceof GitLabCredentialsError) return new GitLabRequestError(error.stderr, 401);
  const cause = (error as { cause?: unknown } | null)?.cause as FailureCause | undefined;
  const status = cause?.response?.status;
  if (typeof status === "number") {
    const description =
      typeof cause?.description === "string" && cause.description
        ? cause.description
        : (error as Error).message;
    return new GitLabRequestError(`GitLab API error (${status}): ${description}`, status);
  }
  if ((error as Error | null)?.name === "GitbeakerTimeoutError") {
    return new GitLabRequestError(
      `GitLab did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`,
      null,
    );
  }
  const code = typeof cause?.code === "string" ? cause.code : null;
  if (code && CERTIFICATE_CODES.has(code)) {
    return new GitLabRequestError(
      `Cannot verify GitLab's certificate (${code}). Install the company CA in the system ` +
        "certificate store, set NODE_EXTRA_CA_CERTS to its PEM file, or point `ssl_verify` " +
        "in the python-gitlab config at it",
      null,
    );
  }
  const detail = typeof cause?.message === "string" ? cause.message : (error as Error).message;
  return new GitLabRequestError(`Cannot reach GitLab${code ? ` (${code})` : ""}: ${detail}`, null);
}

export interface ApiTarget {
  url: string;
  /** python-gitlab config section; without it, `[global] default`. */
  section: string | null;
  env?: NodeJS.ProcessEnv;
}

const cache = new Map<string, { at: number; api: GitLabApi }>();

/** For tests: forget cached credentials. */
export function forgetApis(): void {
  cache.clear();
}

export async function gitlabApi(target: ApiTarget): Promise<GitLabApi> {
  const env = target.env ?? process.env;
  const key = `${target.url}#${target.section ?? ""}#${env.PYTHON_GITLAB_CFG ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CREDENTIALS_CACHE_MS) return hit.api;
  const credentials = await resolveGitLabCredentials({ section: target.section ?? undefined, env });
  installSystemCa({ extraFiles: credentials.caFile ? [credentials.caFile] : [] });
  const tokenOption = { private: "token", oauth: "oauthToken", job: "jobToken" }[credentials.kind];
  const api = new Gitlab({
    host: target.url,
    queryTimeout: REQUEST_TIMEOUT_MS,
    [tokenOption]: credentials.token,
  });
  cache.set(key, { at: Date.now(), api });
  return api;
}

/** A token that is not in the config yet (the setup form), tried once. */
export function gitlabApiWithToken(url: string, token: string): GitLabApi {
  installSystemCa();
  return new Gitlab({ host: url, queryTimeout: REQUEST_TIMEOUT_MS, token });
}

/** Runs one request; a failure becomes a GitLabRequestError, and a rejected token is looked up again. */
export async function request<T>(
  target: ApiTarget,
  operation: (api: GitLabApi) => Promise<unknown>,
  parse: (value: unknown) => T,
): Promise<T> {
  try {
    return parse(await operation(await gitlabApi(target)));
  } catch (error) {
    const failure = describeRequestError(error);
    if (failure.status === 401) forgetApis();
    throw failure;
  }
}
