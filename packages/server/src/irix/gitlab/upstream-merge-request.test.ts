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
import {
  buildNewMergeRequestUrl,
  MergeRequestPageOpenedError,
  openUpstreamMergeRequestPage,
} from "./upstream-merge-request.js";

const config = { url: "https://gitlab.corp.example/" };

function fakeClient(): GitLabClient {
  const projects: Record<string, { id: number; default_branch: string | null }> = {
    "me/app": { id: 11, default_branch: "main" },
    "group/app": { id: 22, default_branch: "develop" },
    "group/empty": { id: 33, default_branch: null },
  };
  return {
    getProject: async ({ project }: { project: string }) => ({
      path_with_namespace: project,
      ...projects[project]!,
    }),
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
    targetPath: "group/sub/app",
    sourceProjectId: 11,
    targetProjectId: 22,
    sourceBranch: "feature/x",
    targetBranch: "develop",
    title: "Add x & y",
    description: "Line one\nLine two",
  };

  it("points at the target project's new merge request page with every field", () => {
    const url = new URL(buildNewMergeRequestUrl(page));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://gitlab.corp.example/group/sub/app/-/merge_requests/new",
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
    expect(url.pathname).toBe("/group/app/-/merge_requests/new");
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
  const saved = { ...process.env };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "irix-upstream-mr-"));
    const certFile = join(work, "localhost.pem");
    writeFileSync(certFile, LOCALHOST_CERT);
    server = https.createServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, (req, res) => {
      const url = req.url ?? "";
      seen.push(`${req.method} ${url.replace("/api/v4", "")}`);
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
      if (req.method === "POST" && url === "/api/v4/projects/me%2Fapp/merge_requests") {
        return send(201, {
          iid: 5,
          web_url: `${baseUrl}/me/app/-/merge_requests/5`,
        });
      }
      return send(500, { message: `unexpected ${req.method} ${url}` });
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
  beforeEach(() => {
    seen = [];
    repo = mkdtempSync(join(work, "repo-"));
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", `${baseUrl}/me/app.git`]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const create = (launch: (url: string) => Promise<void>) => {
    const service = createIrixGitLabAdapter(() => ({ url: baseUrl }), launch).createService();
    return service.createPullRequest({
      cwd: repo,
      title: "Add x",
      body: "Because.",
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
    expect(url.pathname).toBe("/group/app/-/merge_requests/new");
    expect(url.searchParams.get("merge_request[target_branch]")).toBe("develop");
    expect(seen.some((call) => call.startsWith("POST"))).toBe(false);
  });

  it("creates the merge request over the API when there is no upstream remote", async () => {
    const opened: string[] = [];
    const result = await create(async (url) => void opened.push(url));
    expect(result).toEqual({ url: `${baseUrl}/me/app/-/merge_requests/5`, number: 5 });
    expect(opened).toEqual([]);
  });
});
