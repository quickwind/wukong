import { describe, expect, it, vi } from "vitest";

import { type GitLabForgeConfig } from "./config.js";
import { forkPairOf, readRemoteUrls, type RemoteName } from "./fork-scope.js";
import { createGitLabRestClient } from "./rest-client.js";
import { createUpstreamCaches } from "./upstream-cache.js";

const config: GitLabForgeConfig = { url: "https://gitlab.corp.example/" };
const CWD = "/work/app";
const forkProject = async () => ({ id: 42, path_with_namespace: "me/app" });

function remotesOf(values: Partial<Record<RemoteName, string>>) {
  return vi.fn(async (_cwd: string, remote: RemoteName) => values[remote] ?? null);
}

describe("which GitLab project holds a checkout's merge requests", () => {
  describe("forkPairOf", () => {
    it("pairs origin (the fork) with upstream when both are projects on the configured GitLab", () => {
      expect(
        forkPairOf(config, {
          origin: "git@gitlab.corp.example:me/app.git",
          upstream: "https://gitlab.corp.example/team/app.git",
        }),
      ).toEqual({ originPath: "me/app", upstreamPath: "team/app" });
    });

    it("is null without an upstream remote, so nothing changes for a plain clone", () => {
      expect(
        forkPairOf(config, { origin: "git@gitlab.corp.example:me/app.git", upstream: null }),
      ).toBeNull();
    });

    it("is null without an origin remote", () => {
      expect(
        forkPairOf(config, { origin: null, upstream: "git@gitlab.corp.example:team/app.git" }),
      ).toBeNull();
    });

    it("is null when both remotes name the same project, even over different transports", () => {
      expect(
        forkPairOf(config, {
          origin: "git@gitlab.corp.example:team/app.git",
          upstream: "https://gitlab.corp.example/team/app",
        }),
      ).toBeNull();
    });

    it("is null when upstream is not on the configured GitLab", () => {
      expect(
        forkPairOf(config, {
          origin: "git@gitlab.corp.example:me/app.git",
          upstream: "https://github.com/team/app.git",
        }),
      ).toBeNull();
    });

    it("is null when origin is not on the configured GitLab", () => {
      expect(
        forkPairOf(config, {
          origin: "https://github.com/me/app.git",
          upstream: "git@gitlab.corp.example:team/app.git",
        }),
      ).toBeNull();
    });
  });

  describe("readRemoteUrls", () => {
    it("reads origin and upstream, and null for a remote that is not there", async () => {
      const read = remotesOf({ origin: "git@gitlab.corp.example:me/app.git" });
      const caches = createUpstreamCaches();
      const urls = await readRemoteUrls({ cwd: CWD, read, caches, fingerprint: async () => "a" });
      expect(urls).toEqual({ origin: "git@gitlab.corp.example:me/app.git", upstream: null });
      expect(read).toHaveBeenCalledWith(CWD, "origin");
      expect(read).toHaveBeenCalledWith(CWD, "upstream");
    });

    it("keeps the remotes while the config fingerprint is unchanged", async () => {
      const read = remotesOf({ origin: "git@gitlab.corp.example:me/app.git" });
      const caches = createUpstreamCaches();
      const fingerprint = async () => "same";
      await readRemoteUrls({ cwd: CWD, read, caches, fingerprint });
      await readRemoteUrls({ cwd: CWD, read, caches, fingerprint });
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("reads them again once the config fingerprint changes", async () => {
      const read = remotesOf({ origin: "git@gitlab.corp.example:me/app.git" });
      const caches = createUpstreamCaches();
      let fingerprint = "one";
      await readRemoteUrls({ cwd: CWD, read, caches, fingerprint: async () => fingerprint });
      fingerprint = "two";
      await readRemoteUrls({ cwd: CWD, read, caches, fingerprint: async () => fingerprint });
      expect(read).toHaveBeenCalledTimes(4);
    });

    it("never keeps them when there is no fingerprint", async () => {
      const read = remotesOf({ origin: "git@gitlab.corp.example:me/app.git" });
      const caches = createUpstreamCaches();
      const fingerprint = async () => null;
      await readRemoteUrls({ cwd: CWD, read, caches, fingerprint });
      await readRemoteUrls({ cwd: CWD, read, caches, fingerprint });
      expect(read).toHaveBeenCalledTimes(4);
    });
  });

  describe("resolveMergeRequestScope on the REST client", () => {
    const fingerprint = async () => "fp";
    const originUrl = "git@gitlab.corp.example:me/app.git";
    const upstreamUrl = "https://gitlab.corp.example/team/app.git";

    function clientWith(remotes: Partial<Record<RemoteName, string>>) {
      const caches = createUpstreamCaches();
      const client = createGitLabRestClient({
        config,
        readRemote: remotesOf(remotes),
        fingerprint,
        caches,
        // Never reached: the scope is resolved from remotes and the cached fork project.
        resolveCredentials: async () => {
          throw new Error("no credentials in this test");
        },
      });
      return { client, caches };
    }

    it("asks the upstream project for merge requests, and names the fork's project id as their source", async () => {
      const { client, caches } = clientWith({ origin: originUrl, upstream: upstreamUrl });
      await caches.projects.get(`${config.url}|me/app`, "project", forkProject);
      await expect(client.resolveMergeRequestScope(CWD)).resolves.toEqual({
        project: "team/app",
        sourceProjectId: 42,
      });
    });

    it("keeps the origin project and no source filter without an upstream remote", async () => {
      const { client } = clientWith({ origin: originUrl });
      await expect(client.resolveMergeRequestScope(CWD)).resolves.toEqual({
        project: "me/app",
        sourceProjectId: null,
      });
    });
  });
});
