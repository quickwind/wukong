import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { compilePlugin } from "../server/plugins/compiler.js";
import { EgressBlockedError, installEgressGuard } from "./egress-guard.js";
import { readPluginManifest } from "../server/plugins/manifest.js";

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../plugins/irix-gitlab",
);

describe("irix-gitlab plugin", () => {
  it("has a valid manifest whose id matches its directory", async () => {
    const manifest = await readPluginManifest(directory);
    expect(manifest.id).toBe("irix-gitlab");
  });

  it("compiles both its server and client bundles", async () => {
    const bundles = await compilePlugin({
      client: path.join(directory, "index.client.tsx"),
      server: path.join(directory, "index.server.ts"),
    });
    expect(bundles.serverBundle).toContain("irix.gitlab.search");
    // gitbeaker is bundled into the plugin; it is not a host module.
    expect(bundles.serverBundle).toContain("merge_requests");
    expect(bundles.clientBundle).toContain("add-from-gitlab");
  });

  // A plugin bundle cannot import daemon modules, so the plugin carries copies of these two files.
  it.each(["credentials.ts", "system-ca.ts"])(
    "keeps its copy of %s identical to the daemon's",
    (file) => {
      const daemon = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "gitlab", file);
      expect(readFileSync(path.join(directory, "server", file), "utf8")).toBe(
        readFileSync(daemon, "utf8"),
      );
    },
  );

  it("gets its GitLab requests past the egress guard, and only for the host it is given", async () => {
    const uninstall = installEgressGuard();
    try {
      const { gitlabApiWithToken } = (await import(
        pathToFileURL(path.join(directory, "server", "api.ts")).href
      )) as typeof import("../../../../plugins/irix-gitlab/server/api.js");
      const reason = async (url: string): Promise<string> => {
        try {
          await gitlabApiWithToken(url, "t").Users.showCurrentUser();
          return "";
        } catch (error) {
          const cause = (error as { cause?: unknown }).cause;
          return cause instanceof EgressBlockedError ? "blocked" : "reached";
        }
      };
      // .invalid never resolves: "reached" means the guard let the connection attempt through.
      expect(await reason("https://gitlab.company.invalid")).toBe("reached");
      await expect(fetch("https://elsewhere.invalid/")).rejects.toMatchObject({
        cause: expect.any(EgressBlockedError),
      });
    } finally {
      uninstall();
    }
  });
});
