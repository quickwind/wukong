import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BuiltinPluginLoader } from "../server/plugins/builtin/index.js";
import { ManagedPluginSources } from "../server/plugins/managed-source.js";
import { activateIrixPolicy } from "./policy.js";
import {
  irixBuiltinPlugins,
  irixManagedSources,
  pluginSourcesUnavailableMessage,
} from "./plugins.js";

describe("Irix plugins", () => {
  const sources = new ManagedPluginSources("/tmp/irix-test-home");
  const loader = new BuiltinPluginLoader();

  it("passes upstream wiring through until activated", () => {
    expect(irixManagedSources(sources)).toBe(sources);
    expect(irixBuiltinPlugins(loader)).toBe(loader);
  });

  describe("once active", () => {
    let deactivate: () => void;
    beforeEach(() => {
      deactivate = activateIrixPolicy();
    });
    afterEach(() => deactivate());

    it("drops managed (npm, Git, registry) sources", () => {
      expect(irixManagedSources(sources)).toBeUndefined();
    });

    it("starts only Irix's own bundled plugins", () => {
      expect([...(irixBuiltinPlugins(loader)?.ids ?? [])]).toEqual([
        "irix-gitlab",
        "irix-devin-usage",
      ]);
    });
  });

  it("keeps upstream's message until active, then says to install from a local folder", () => {
    expect(pluginSourcesUnavailableMessage("upstream says no")).toBe("upstream says no");
    const deactivate = activateIrixPolicy();
    try {
      expect(pluginSourcesUnavailableMessage("upstream says no")).toMatch(
        /local folder only.*irix plugin install <folder>/,
      );
    } finally {
      deactivate();
    }
  });
});
