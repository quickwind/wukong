import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { compilePlugin } from "../server/plugins/compiler.js";
import { readPluginManifest } from "../server/plugins/manifest.js";

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../plugins/irix-claude-usage",
);

describe("irix-claude-usage plugin", () => {
  it("has a valid manifest whose id matches its directory", async () => {
    const manifest = await readPluginManifest(directory);
    expect(manifest.id).toBe("irix-claude-usage");
  });

  it("shows the Claude provider's own icon, not the generic gauge", async () => {
    const svg = readFileSync(path.join(directory, "icon.svg"), "utf8");
    const upstream = readFileSync(
      path.resolve(directory, "../claude-usage-source/icon.svg"),
      "utf8",
    );
    expect(svg).toBe(upstream);
    expect(svg).toContain("currentColor");
    const bundles = await compilePlugin({ server: path.join(directory, "index.server.ts") });
    expect(bundles.serverBundle).toMatch(/icon:\s*"icon\.svg"/);
  });

  it("compiles to a server bundle that registers the claude usage source", async () => {
    const bundles = await compilePlugin({ server: path.join(directory, "index.server.ts") });
    expect(bundles.serverBundle).toContain("registerUsageSource");
    expect(bundles.serverBundle).toContain("api/oauth/usage");
  });
});
