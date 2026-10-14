import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compilePlugin } from "../server/plugins/compiler.js";
import { readPluginManifest } from "../server/plugins/manifest.js";

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../plugins/irix-devin-usage",
);

describe("irix-devin-usage plugin", () => {
  it("has a valid manifest whose id matches its directory", async () => {
    const manifest = await readPluginManifest(directory);
    expect(manifest.id).toBe("irix-devin-usage");
  });

  it("compiles to a server bundle that registers the devin usage source", async () => {
    const bundles = await compilePlugin({ server: path.join(directory, "index.server.ts") });
    expect(bundles.serverBundle).toContain("registerUsageSource");
    expect(bundles.serverBundle).toContain("GetUserStatus");
  });
});
