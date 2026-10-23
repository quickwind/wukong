// Test helper: a stand-in GitLab (https, self-signed certificate) that the plugin's tests talk to
// for real. Lives under test/ so the build of the built-in plugins leaves it out.

import { mkdtempSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCALHOST_CERT, LOCALHOST_KEY } from "./localhost-tls.js";

export interface FakeProject {
  path_with_namespace: string;
  namespace?: { kind: string };
  forked_from_project?: { path_with_namespace: string };
  /** `get` calls before a new fork reports its import as finished. */
  import_after?: number;
  fail?: string;
  polls?: number;
}

/** An answer that is an error: the status and message GitLab sends. */
export interface FakeError {
  status: number;
  message: string;
}

export interface FakeState {
  username: string;
  list: unknown[];
  projects: Record<string, FakeProject>;
  /** `GET /user` fails with a 401, as when the token is wrong. */
  noUser?: boolean;
  /** The answer to `GET /personal_access_tokens/self`. */
  self: unknown;
  /** Requests carrying any other token get a 401. */
  requireToken?: string;
  importPolls: number;
  /** `METHOD /path?query` of every request, in order. */
  calls: string[];
  /** The `PRIVATE-TOKEN` header of every request. */
  tokens: Array<string | undefined>;
}

export function defaultState(partial: Partial<FakeState> = {}): FakeState {
  return {
    username: "me",
    list: [],
    projects: { "group/app": { path_with_namespace: "group/app", namespace: { kind: "group" } } },
    self: {
      active: true,
      revoked: false,
      expires_at: null,
      scopes: ["api", "read_repository", "write_repository"],
    },
    importPolls: 2,
    calls: [],
    tokens: [],
    ...partial,
  };
}

function isError(value: unknown): value is FakeError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FakeError).status === "number" &&
    typeof (value as FakeError).message === "string"
  );
}

function importStatus(project: FakeProject): string {
  if (project.fail) return "failed";
  return (project.polls ?? 0) >= (project.import_after ?? 0) ? "finished" : "started";
}

function view(project: FakeProject) {
  return {
    ...project,
    import_status: importStatus(project),
    import_error: project.fail ?? null,
  };
}

export interface FakeGitLab {
  /** `https://localhost:<port>` */
  url: string;
  state: FakeState;
  /** PEM file of the server certificate, for `ssl_verify` in a python-gitlab config. */
  certFile: string;
  /** Replaces the state in place (keeps `calls` empty). */
  seed(partial?: Partial<FakeState>): void;
  close(): Promise<void>;
}

export async function startFakeGitLab(partial: Partial<FakeState> = {}): Promise<FakeGitLab> {
  const state = defaultState(partial);
  const directory = mkdtempSync(join(tmpdir(), "irix-fake-gitlab-"));
  const certFile = join(directory, "localhost.pem");
  writeFileSync(certFile, LOCALHOST_CERT);

  const server = https.createServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, (req, res) => {
    const url = new URL(req.url ?? "/", "https://localhost");
    const token = req.headers["private-token"] as string | undefined;
    state.calls.push(`${req.method} ${url.pathname.replace(/^\/api\/v4/u, "")}${url.search}`);
    state.tokens.push(token);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = url.pathname.replace(/^\/api\/v4/u, "");
    if (state.requireToken && token !== state.requireToken) {
      return send(401, { message: "401 Unauthorized" });
    }
    if (path === "/personal_access_tokens/self") {
      return isError(state.self)
        ? send(state.self.status, { message: state.self.message })
        : send(200, state.self);
    }
    if (path === "/user") {
      return state.noUser
        ? send(401, { message: "401 Unauthorized" })
        : send(200, { id: 1, username: state.username });
    }
    if (path === "/projects" && req.method === "GET") return send(200, state.list);
    const fork = /^\/projects\/([^/]+)\/fork$/u.exec(path);
    if (fork && req.method === "POST") {
      const source = decodeURIComponent(fork[1] ?? "");
      const target = `${state.username}/${source.split("/").at(-1)}`;
      if (state.projects[target]) {
        return send(409, { message: "Project namespace name has already been taken" });
      }
      state.projects[target] = {
        path_with_namespace: target,
        namespace: { kind: "user" },
        forked_from_project: { path_with_namespace: source },
        import_after: state.importPolls,
        polls: 0,
      };
      return send(201, view(state.projects[target]));
    }
    const project = /^\/projects\/([^/]+)$/u.exec(path);
    if (project && req.method === "GET") {
      const found = state.projects[decodeURIComponent(project[1] ?? "")];
      if (!found) return send(404, { message: "404 Project Not Found" });
      found.polls = (found.polls ?? 0) + 1;
      return send(200, view(found));
    }
    return send(500, { message: `unexpected ${req.method} ${path}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `https://localhost:${(server.address() as AddressInfo).port}`;

  return {
    url,
    state,
    certFile,
    seed(next = {}) {
      delete state.noUser;
      delete state.requireToken;
      Object.assign(state, defaultState(next));
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A python-gitlab config with one section pointing at `fake`, trusting its certificate. */
export function writeCfg(
  file: string,
  fake: Pick<FakeGitLab, "url" | "certFile">,
  options: { section?: string; token?: string } = {},
): void {
  const section = options.section ?? "corp";
  writeFileSync(
    file,
    `[global]\ndefault = ${section}\n\n[${section}]\nurl = ${fake.url}\nprivate_token = ${options.token ?? "good"}\nssl_verify = ${fake.certFile}\n`,
  );
}
