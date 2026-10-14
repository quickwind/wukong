import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compilePlugin } from "../server/plugins/compiler.js";
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
    expect(bundles.clientBundle).toContain("add-from-gitlab");
  });
});
