// Drives the REST client against a real https server with a self-signed certificate (test-only
// key pair in fixtures/, valid for localhost and 127.0.0.1), so the TLS trust and the token header
// are the real thing.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { GitLabApiError } from "./client.js";
import { LOCALHOST_CERT, LOCALHOST_KEY } from "./fixtures/localhost-tls.js";
import { parseCfg, resolveGitLabCredentials } from "./credentials.js";
import { createGitLabRestClient } from "./rest-client.js";
import { installEgressGuard } from "../egress-guard.js";
import { installSystemCa } from "./system-ca.js";

const CERT_FILE = join(mkdtempSync(join(tmpdir(), "irix-rest-cert-")), "localhost.pem");
writeFileSync(CERT_FILE, LOCALHOST_CERT);

interface Seen {
  method: string;
  url: string;
  token: string | undefined;
}

const mergeRequest = {
  iid: 7,
  title: "Add thing",
  web_url: "https://gitlab.example.com/g/app/-/merge_requests/7",
  state: "opened",
  source_branch: "feature",
  target_branch: "main",
  sha: "abc",
  references: { full: "g/app!7" },
};

const asApiError = (error: unknown) => error as GitLabApiError;

describe("GitLab REST client", () => {
  let server: https.Server;
  let baseUrl: string;
  let seen: Seen[] = [];
  const originalCas = (
    tls as unknown as { getCACertificates?: (t: string) => string[] }
  ).getCACertificates?.("default");
  let directory: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "irix-rest-"));
    server = https.createServer(
      { cert: LOCALHOST_CERT, key: LOCALHOST_KEY },
      (request, response) => {
        const url = request.url ?? "";
        seen.push({
          method: request.method ?? "",
          url,
          token: request.headers["private-token"] as string | undefined,
        });
        const send = (status: number, body: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (url.startsWith("/api/v4/projects/g%2Fapp/merge_requests/7/approvals")) {
          return send(200, { approvals_required: 2, approvals_left: 1 });
        }
        if (url.startsWith("/api/v4/projects/g%2Fapp/merge_requests/7")) {
          return send(200, mergeRequest);
        }
        if (url.startsWith("/api/v4/projects/g%2Fapp/merge_requests/8")) {
          return send(401, { message: "401 Unauthorized" });
        }
        if (url.startsWith("/api/v4/projects/g%2Fnope/")) {
          return send(404, { message: "404 Project Not Found" });
        }
        if (url.startsWith("/api/v4/projects/g%2Fapp/merge_requests")) {
          return send(200, [mergeRequest]);
        }
        return send(500, { message: `unexpected ${request.method} ${url}` });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `https://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
    const store = tls as unknown as { setDefaultCACertificates?: (certs: string[]) => void };
    if (originalCas) store.setDefaultCACertificates?.(originalCas);
  });

  afterEach(() => {
    seen = [];
  });

  function client(token = "secret-token") {
    return createGitLabRestClient({
      config: { url: baseUrl },
      resolveRemoteUrl: async () => null,
      resolveCredentials: async () => ({ kind: "private", token, caFile: null }),
    });
  }

  it("refuses the self-signed certificate until its CA is trusted, then reads and sends the token", async () => {
    const failure = await client()
      .getMergeRequest({ cwd: "/x", project: "g/app", iid: 7 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitLabApiError);
    expect((failure as GitLabApiError).stderr).toMatch(/certificate/iu);

    installSystemCa({ extraFiles: [CERT_FILE] });
    const mr = await client().getMergeRequest({ cwd: "/x", project: "g/app", iid: 7 });
    expect(mr.iid).toBe(7);
    expect(seen.at(-1)?.token).toBe("secret-token");
  });

  it("lists merge requests and reads approvals", async () => {
    installSystemCa({ extraFiles: [CERT_FILE] });
    const gitlab = client();
    expect(
      await gitlab.listMergeRequests({ cwd: "/x", project: "g/app", state: "opened" }),
    ).toHaveLength(1);
    expect(seen[0]?.url).toContain("state=opened");
    expect(await gitlab.getApprovals({ cwd: "/x", project: "g/app", iid: 7 })).toMatchObject({
      approvals_left: 1,
    });
  });

  it("keeps the HTTP status in the failure so upstream can classify it", async () => {
    installSystemCa({ extraFiles: [CERT_FILE] });
    const unauthorized = await client()
      .getMergeRequest({ cwd: "/x", project: "g/app", iid: 8 })
      .catch((error: unknown) => error as GitLabApiError);
    expect(unauthorized).toMatchObject({ status: 401 });
    expect((unauthorized as GitLabApiError).stderr).toMatch(/401/u);

    const missing = await client()
      .getMergeRequest({ cwd: "/x", project: "g/nope", iid: 1 })
      .catch((error: unknown) => error as GitLabApiError);
    expect(missing).toMatchObject({ status: 404 });
  });

  it("reports an unreachable server by its error code", async () => {
    // A port nothing listens on: the server above, once closed.
    const spare = https.createServer();
    await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
    const port = (spare.address() as AddressInfo).port;
    await new Promise((resolve) => spare.close(resolve));
    const closed = createGitLabRestClient({
      config: { url: `https://127.0.0.1:${port}` },
      resolveRemoteUrl: async () => null,
      resolveCredentials: async () => ({ kind: "private", token: "t", caFile: null }),
    });
    const failure = await closed
      .currentUser("/x")
      .catch((error: unknown) => error as GitLabApiError);
    expect(failure.stderr).toMatch(/Cannot reach GitLab \(ECONNREFUSED\)/u);
  });

  describe("credentials from the python-gitlab config", () => {
    it("reads the default section, honours helper:, and the environment wins", async () => {
      const cfg = join(directory, "python-gitlab.cfg");
      const helper = join(directory, "helper.mjs");
      writeFileSync(helper, "process.stdout.write('from-helper\\n');");
      writeFileSync(
        cfg,
        [
          "[global]",
          "default = main",
          "",
          "[main]",
          "url = https://gitlab.example.com",
          "private_token = plain-token",
          "ssl_verify = /etc/company-ca.pem",
          "",
          "[viahelper]",
          "url: https://gitlab.example.com",
          `private_token: helper: "${process.execPath}" "${helper}"`,
          "",
        ].join("\n"),
      );
      const env = { PYTHON_GITLAB_CFG: cfg };
      expect(await resolveGitLabCredentials({ env })).toEqual({
        kind: "private",
        token: "plain-token",
        caFile: "/etc/company-ca.pem",
      });
      expect(await resolveGitLabCredentials({ env, section: "viahelper" })).toMatchObject({
        token: "from-helper",
      });
      expect(
        await resolveGitLabCredentials({ env: { ...env, GITLAB_PRIVATE_TOKEN: "from-env" } }),
      ).toMatchObject({ token: "from-env" });
    });

    it("says authentication failed when there is no token", async () => {
      const cfg = join(directory, "empty.cfg");
      writeFileSync(cfg, "[global]\ndefault = main\n[main]\nurl = https://x\n");
      await expect(resolveGitLabCredentials({ env: { PYTHON_GITLAB_CFG: cfg } })).rejects.toThrow(
        /Authentication failed/u,
      );
    });

    it("does not treat ssl_verify booleans as a CA file", () => {
      expect(parseCfg("[a]\nssl_verify = false\n").get("a")?.get("ssl_verify")).toBe("false");
    });
  });

  describe("with the egress guard installed", () => {
    it("allows the configured GitLab host and no other", async () => {
      const uninstall = installEgressGuard();
      try {
        const make = (host: string) =>
          createGitLabRestClient({
            config: { url: `https://${host}` },
            resolveRemoteUrl: async () => null,
            resolveCredentials: async () => ({ kind: "private", token: "t", caFile: null }),
          });
        // The configured host gets past the guard (and then fails to resolve, as .invalid never does).
        const reached = await make("gitlab.company.invalid").currentUser("/x").catch(asApiError);
        expect(reached.stderr).toMatch(/Cannot reach GitLab/u);
        expect(reached.stderr).not.toMatch(/Irix blocked/u);
        // A host nobody configured stays blocked, whatever else has been allowed.
        const other = await createGitLabRestClient({
          config: { url: "https://other.invalid" },
          resolveRemoteUrl: async () => null,
          resolveCredentials: async () => {
            throw new GitLabApiError("no credentials");
          },
        })
          .currentUser("/x")
          .catch(asApiError);
        expect(other.stderr).toBe("no credentials");
      } finally {
        uninstall();
      }
    });
  });
});
