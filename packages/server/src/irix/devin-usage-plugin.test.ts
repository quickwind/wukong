import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ACP_PROVIDER_ICON_SVGS as acpProviderIcons } from "../../../app/src/assets/acp-provider-icons.js";
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

  it("shows the Devin provider's own icon, not the generic gauge", async () => {
    const svg = readFileSync(path.join(directory, "icon.svg"), "utf8");
    expect(svg).toBe(acpProviderIcons.devin);
    expect(svg).toContain("currentColor");
    const bundles = await compilePlugin({ server: path.join(directory, "index.server.ts") });
    expect(bundles.serverBundle).toMatch(/icon:\s*"icon\.svg"/);
  });

  it("compiles to a server bundle that registers the devin usage source", async () => {
    const bundles = await compilePlugin({ server: path.join(directory, "index.server.ts") });
    expect(bundles.serverBundle).toContain("registerUsageSource");
    expect(bundles.serverBundle).toContain("GetUserStatus");
  });
});
