import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createIrixGitLabAdapter } from "./adapter.js";
import type { GitLabClient } from "./client.js";
import { LOCALHOST_CERT, LOCALHOST_KEY } from "./fixtures/localhost-tls.js";
import { installSystemCa } from "./system-ca.js";
import { createUpstreamCaches } from "./upstream-cache.js";
import {
  buildNewMergeRequestUrl,
  MergeRequestPageOpenedError,
  openUpstreamMergeRequestPage,
} from "./upstream-merge-request.js";

const config = { url: "https://gitlab.corp.example/" };

interface FakeGitLabHooks {
  mergeRequestState(): string;
  seen(call: string): void;
  posted(body: Record<string, unknown>): void;
  baseUrl(): string;
}

async function handleFakeGitLab(
  hooks: FakeGitLabHooks,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const url = req.url ?? "";
  hooks.seen(`${req.method} ${url.replace("/api/v4", "")}`);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url === "/api/v4/projects/me%2Fapp") {
    return send(200, { id: 11, path_with_namespace: "me/app", default_branch: "main" });
  }
  if (url === "/api/v4/projects/group%2Fapp") {
    return send(200, { id: 22, path_with_namespace: "group/app", default_branch: "develop" });
  }
  const mergeRequest = {
    iid: 9,
    title: "Add x",
    web_url: `${hooks.baseUrl()}/me/app/-/merge_requests/9`,
    state: hooks.mergeRequestState(),
    source_branch: "feature",
    target_branch: "main",
    sha: "abc123",
    references: { full: "me/app!9" },
  };
  // The upstream project holds the fork's request (iid 21, from project 11) and, on a branch of
  // the same name, someone else's (iid 20, from project 99).
  const inUpstream = (iid: number, sourceProjectId: number, state: string, sha: string) => ({
    iid,
    title: `Request ${iid}`,
    web_url: `${hooks.baseUrl()}/group/app/-/merge_requests/${iid}`,
    state,
    source_branch: "feature",
    target_branch: "develop",
    source_project_id: sourceProjectId,
    sha,
    references: { full: `group/app!${iid}` },
  });
  if (url.startsWith("/api/v4/projects/group%2Fapp/merge_requests?")) {
    return send(200, [
      inUpstream(20, 99, "opened", "zzz999"),
      inUpstream(21, 11, hooks.mergeRequestState(), "abc123"),
    ]);
  }
  if (url === "/api/v4/projects/group%2Fapp/merge_requests/21") {
    return send(200, inUpstream(21, 11, hooks.mergeRequestState(), "abc123"));
  }
  if (url.startsWith("/api/v4/projects/group%2Fapp/merge_requests/21/approvals")) {
    return send(200, { approvals_required: 0, approvals_left: 0 });
  }
  if (url.startsWith("/api/v4/projects/group%2Fapp/merge_requests/21/pipelines")) {
    return send(200, []);
  }
  if (url.startsWith("/api/v4/projects/me%2Fapp/merge_requests?")) {
    return send(200, [mergeRequest]);
  }
  if (url === "/api/v4/projects/me%2Fapp/merge_requests/9") return send(200, mergeRequest);
  if (url.startsWith("/api/v4/projects/me%2Fapp/merge_requests/9/approvals")) {
    return send(200, { approvals_required: 0, approvals_left: 0 });
  }
  if (url.startsWith("/api/v4/projects/me%2Fapp/merge_requests/9/pipelines")) {
    return send(200, []);
  }
  if (req.method === "POST" && url === "/api/v4/projects/me%2Fapp/merge_requests") {
    hooks.posted(await readJson(req));
    return send(201, { iid: 5, web_url: `${hooks.baseUrl()}/me/app/-/merge_requests/5` });
  }
  return send(500, { message: `unexpected ${req.method} ${url}` });
}

const sawRequest = (calls: string[], prefix: string) =>
  calls.some((call) => call.startsWith(prefix));

async function readJson(
  req: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  return JSON.parse(text) as Record<string, unknown>;
}

function fakeClient(lookups: string[] = []): GitLabClient {
  const projects: Record<string, { id: number; default_branch: string | null }> = {
    "me/app": { id: 11, default_branch: "main" },
    "group/app": { id: 22, default_branch: "develop" },
    "group/empty": { id: 33, default_branch: null },
  };
  return {
    getProject: async ({ project }: { project: string }) => {
      lookups.push(project);
      return { path_with_namespace: project, ...projects[project]! };
    },
  } as unknown as GitLabClient;
}

const remotes =
  (map: Record<string, string | null>) =>
  async (_cwd: string, remote: string): Promise<string | null> =>
    map[remote] ?? null;

const forkRemotes = {
  origin: "git@gitlab.corp.example:me/app.git",
  upstream: "https://gitlab.corp.example/group/app.git",
};

const input = { cwd: "/repo", head: "feature/x", title: "Add x", body: "Because." };

describe("buildNewMergeRequestUrl", () => {
  const page = {
    baseUrl: "https://gitlab.corp.example",
    sourcePath: "me/sub/app",
    sourceProjectId: 11,
    targetProjectId: 22,
    sourceBranch: "feature/x",
    targetBranch: "develop",
    title: "Add x & y",
    description: "Line one\nLine two",
  };

  it("points at the new merge request page of the project the branch is in, with every field", () => {
    const url = new URL(buildNewMergeRequestUrl(page));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://gitlab.corp.example/me/sub/app/-/merge_requests/new",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "merge_request[source_project_id]": "11",
      "merge_request[source_branch]": "feature/x",
      "merge_request[target_project_id]": "22",
      "merge_request[target_branch]": "develop",
      "merge_request[title]": "Add x & y",
      "merge_request[description]": "Line one\nLine two",
    });
  });

  it("cuts a very long description to keep the address usable, and keeps the title", () => {
    const url = buildNewMergeRequestUrl({ ...page, description: "word ".repeat(5000) });
    expect(url.length).toBeLessThanOrEqual(6000);
    expect(new URL(url).searchParams.get("merge_request[title]")).toBe("Add x & y");
    expect(new URL(url).searchParams.get("merge_request[description]")?.startsWith("word")).toBe(
      true,
    );
  });

  it("leaves the title and description to GitLab when none is given", () => {
    const { title: _title, description: _description, ...bare } = page;
    const url = new URL(buildNewMergeRequestUrl(bare));
    expect([...url.searchParams.keys()].sort()).toEqual([
      "merge_request[source_branch]",
      "merge_request[source_project_id]",
      "merge_request[target_branch]",
      "merge_request[target_project_id]",
    ]);
  });

  it("leaves out an empty description", () => {
    const url = new URL(buildNewMergeRequestUrl({ ...page, description: "" }));
    expect(url.searchParams.has("merge_request[description]")).toBe(false);
  });
});

describe("openUpstreamMergeRequestPage", () => {
  it("opens the page from the fork's branch to upstream's default branch", async () => {
    const opened: string[] = [];
    const error = await openUpstreamMergeRequestPage(
      {
        config,
        client: fakeClient(),
        resolveRemoteUrl: remotes(forkRemotes),
        launch: async (url) => void opened.push(url),
      },
      input,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeRequestPageOpenedError);
    expect((error as Error).message).toContain("me/app:feature/x → group/app:develop");
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0] ?? "");
    // The page is the fork's (where the branch is); the upstream project is the target.
    expect(url.pathname).toBe("/me/app/-/merge_requests/new");
    expect(url.searchParams.get("merge_request[source_project_id]")).toBe("11");
    expect(url.searchParams.get("merge_request[target_project_id]")).toBe("22");
    expect(url.searchParams.get("merge_request[target_branch]")).toBe("develop");
    expect(url.searchParams.get("merge_request[title]")).toBe("Add x");
    expect(url.searchParams.get("merge_request[description]")).toBe("Because.");
  });

  it.each([
    ["no upstream remote", { origin: forkRemotes.origin }],
    [
      "upstream on another server",
      { ...forkRemotes, upstream: "https://github.com/group/app.git" },
    ],
    ["upstream is the same project as origin", { ...forkRemotes, upstream: forkRemotes.origin }],
    ["no origin", { upstream: forkRemotes.upstream }],
  ])("leaves the request to the API when there is %s", async (_name, map) => {
    const opened: string[] = [];
    const result = await openUpstreamMergeRequestPage(
      {
        config,
        client: fakeClient(),
        resolveRemoteUrl: remotes(map),
        launch: async (url) => void opened.push(url),
      },
      input,
    );
    expect(result).toBe(false);
    expect(opened).toEqual([]);
  });

  describe("cache", () => {
    const click = (
      deps: Partial<Parameters<typeof openUpstreamMergeRequestPage>[0]> & {
        reads: string[];
        lookups: string[];
        opened: string[];
      },
    ) =>
      openUpstreamMergeRequestPage(
        {
          config,
          client: fakeClient(deps.lookups),
          resolveRemoteUrl: async (_cwd, remote) => {
            deps.reads.push(remote);
            return forkRemotes[remote as keyof typeof forkRemotes] ?? null;
          },
          launch: async (url) => void deps.opened.push(url),
          ...deps,
        },
        { cwd: "/repo", head: "feature/x" },
      ).catch((e: unknown) => e);

    it("looks the remotes and both projects up once, however often the button is pressed", async () => {
      const state = { reads: [] as string[], lookups: [] as string[], opened: [] as string[] };
      const caches = createUpstreamCaches();
      const fingerprint = async () => "config-v1";
      for (let press = 0; press < 3; press += 1) {
        expect(await click({ ...state, caches, fingerprint })).toBeInstanceOf(
          MergeRequestPageOpenedError,
        );
      }
      expect(state.reads.sort()).toEqual(["origin", "upstream"]);
      expect(state.lookups.sort()).toEqual(["group/app", "me/app"]);
      expect(state.opened).toHaveLength(3);
      expect(new Set(state.opened).size).toBe(1);
    });

    it("reads the remotes again when the repository's config changes, and keeps the projects", async () => {
      const state = { reads: [] as string[], lookups: [] as string[], opened: [] as string[] };
      const caches = createUpstreamCaches();
      await click({ ...state, caches, fingerprint: async () => "config-v1" });
      await click({ ...state, caches, fingerprint: async () => "config-v2" });
      expect(state.reads).toHaveLength(4);
      expect(state.lookups).toHaveLength(2);
    });

    it("notices an upstream remote added after a click that found none", async () => {
      const caches = createUpstreamCaches();
      const without = { origin: forkRemotes.origin };
      const opened: string[] = [];
      const deps = (map: Record<string, string | null>, fingerprint: string) => ({
        config,
        client: fakeClient(),
        caches,
        fingerprint: async () => fingerprint,
        resolveRemoteUrl: remotes(map),
        launch: async (url: string) => void opened.push(url),
      });
      expect(await openUpstreamMergeRequestPage(deps(without, "v1"), input)).toBe(false);
      await expect(openUpstreamMergeRequestPage(deps(forkRemotes, "v2"), input)).rejects.toThrow(
        MergeRequestPageOpenedError,
      );
    });

    it("keeps nothing when it cannot tell whether the config changed", async () => {
      const state = { reads: [] as string[], lookups: [] as string[], opened: [] as string[] };
      const caches = createUpstreamCaches();
      await click({ ...state, caches, fingerprint: async () => null });
      await click({ ...state, caches, fingerprint: async () => null });
      expect(state.reads).toHaveLength(4);
    });

    it("does not remember a failed project lookup", async () => {
      const caches = createUpstreamCaches();
      let failing = true;
      const client = {
        getProject: async ({ project }: { project: string }) => {
          if (failing) throw new Error("GitLab is down");
          return { id: 1, path_with_namespace: project, default_branch: "main" };
        },
      } as unknown as GitLabClient;
      const deps = {
        config,
        client,
        caches,
        fingerprint: async () => "v1",
        resolveRemoteUrl: remotes(forkRemotes),
        launch: async () => {},
      };
      await expect(openUpstreamMergeRequestPage(deps, input)).rejects.toThrow("GitLab is down");
      failing = false;
      await expect(openUpstreamMergeRequestPage(deps, input)).rejects.toThrow(
        MergeRequestPageOpenedError,
      );
    });
  });

  it("gives the link when the browser cannot be started", async () => {
    const error = (await openUpstreamMergeRequestPage(
      {
        config,
        client: fakeClient(),
        resolveRemoteUrl: remotes(forkRemotes),
        launch: async () => {
          throw new Error("spawn xdg-open ENOENT");
        },
      },
      input,
    ).catch((e: unknown) => e)) as MergeRequestPageOpenedError;
    expect(error.message).toContain("Could not open the browser (spawn xdg-open ENOENT)");
    expect(error.message).toContain(error.url);
  });

  it("refuses an upstream project with no default branch", async () => {
    await expect(
      openUpstreamMergeRequestPage(
        {
          config,
          client: fakeClient(),
          resolveRemoteUrl: remotes({
            ...forkRemotes,
            upstream: "git@gitlab.corp.example:group/empty.git",
          }),
          launch: async () => {},
        },
        input,
      ),
    ).rejects.toThrow(/no default branch/);
  });
});

describe("Create merge request through the GitLab adapter", () => {
  let server: https.Server;
  let baseUrl: string;
  let work: string;
  let seen: string[] = [];
  let posted: Array<Record<string, unknown>> = [];
  let mergeRequestState = "opened";
  const saved = { ...process.env };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "irix-upstream-mr-"));
    const certFile = join(work, "localhost.pem");
    writeFileSync(certFile, LOCALHOST_CERT);
    const hooks: FakeGitLabHooks = {
      mergeRequestState: () => mergeRequestState,
      seen: (call) => seen.push(call),
      posted: (body) => posted.push(body),
      baseUrl: () => baseUrl,
    };
    server = https.createServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, (req, res) => {
      void handleFakeGitLab(hooks, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `https://localhost:${(server.address() as AddressInfo).port}`;
    installSystemCa({ extraFiles: [certFile] });
    const cfg = join(work, "python-gitlab.cfg");
    writeFileSync(cfg, `[global]\ndefault = t\n\n[t]\nurl = ${baseUrl}\nprivate_token = tok\n`);
    process.env.PYTHON_GITLAB_CFG = cfg;
    delete process.env.GITLAB_PRIVATE_TOKEN;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
    Object.assign(process.env, saved);
  });

  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      stdio: "ignore",
    });
  const commit = (message: string) => {
    writeFileSync(join(repo, "f.txt"), `${message}\n${Math.random()}`);
    git("add", ".");
    git("commit", "-m", message);
  };

  beforeEach(() => {
    seen = [];
    posted = [];
    mergeRequestState = "opened";
    repo = mkdtempSync(join(work, "repo-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    commit("Initial");
    git("remote", "add", "origin", `${baseUrl}/me/app.git`);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  // The title and description arrive empty, as the Irix generator leaves them.
  const create = (launch: (url: string) => Promise<void>, title = "") => {
    const service = createIrixGitLabAdapter(() => ({ url: baseUrl }), launch).createService();
    return service.createPullRequest({
      cwd: repo,
      title,
      body: "",
      head: "feature",
      base: "main",
    });
  };

  it("opens the upstream page and creates nothing when an upstream remote exists", async () => {
    execFileSync("git", ["-C", repo, "remote", "add", "upstream", `${baseUrl}/group/app.git`]);
    const opened: string[] = [];
    await expect(create(async (url) => void opened.push(url))).rejects.toThrow(
      /Opened the new merge request page/,
    );
    const url = new URL(opened[0] ?? "");
    expect(url.pathname).toBe("/me/app/-/merge_requests/new");
    expect(url.searchParams.get("merge_request[target_project_id]")).toBe("22");
    expect(url.searchParams.get("merge_request[target_branch]")).toBe("develop");
    expect(url.searchParams.get("merge_request[source_branch]")).toBe("feature");
    // GitLab writes the title and description.
    expect(url.searchParams.has("merge_request[title]")).toBe(false);
    expect(url.searchParams.has("merge_request[description]")).toBe(false);
    expect(seen.some((call) => call.startsWith("POST"))).toBe(false);
  });

  it("creates the merge request over the API, with a title drafted from the commits, when there is no upstream remote", async () => {
    git("checkout", "-q", "-b", "feature");
    commit("Add x\n\nBecause.");
    const opened: string[] = [];
    const result = await create(async (url) => void opened.push(url));
    expect(result).toEqual({ url: `${baseUrl}/me/app/-/merge_requests/5`, number: 5 });
    expect(opened).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ title: "Add x", description: "Because." });
  });

  it("uses the title it is given", async () => {
    await create(async () => {}, "Explicit title");
    expect(posted[0]).toMatchObject({ title: "Explicit title" });
  });

  describe("the branch's current merge request", () => {
    const status = () =>
      createIrixGitLabAdapter(
        () => ({ url: baseUrl }),
        async () => {},
      )
        .createService()
        .getCurrentPullRequestStatus({
          cwd: repo,
          headRef: "feature",
          headSha: "abc123",
        } as never);

    it("is shown while it is open", async () => {
      mergeRequestState = "opened";
      expect(await status()).toMatchObject({ number: 9, state: "open" });
    });

    it("is shown once merged", async () => {
      mergeRequestState = "merged";
      expect(await status()).toMatchObject({ number: 9, state: "merged", isMerged: true });
    });

    it("is not shown once closed without merging, so a new one can be created", async () => {
      mergeRequestState = "closed";
      expect(await status()).toBeNull();
    });

    it("is found in the upstream project, and is the fork's own, not a namesake's", async () => {
      git("remote", "add", "upstream", `${baseUrl}/group/app.git`);
      mergeRequestState = "opened";
      expect(await status()).toMatchObject({ number: 21, state: "open" });
      expect(sawRequest(seen, "GET /projects/group%2Fapp/merge_requests?")).toBe(true);
      // Nothing was looked for in the fork's own project.
      expect(sawRequest(seen, "GET /projects/me%2Fapp/merge_requests")).toBe(false);
    });

    it("is not shown in a fork once closed without merging", async () => {
      git("remote", "add", "upstream", `${baseUrl}/group/app.git`);
      mergeRequestState = "closed";
      expect(await status()).toBeNull();
    });
  });
});
