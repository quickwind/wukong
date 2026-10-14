import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildProviderRegistry } from "../server/agent/provider-registry.js";
import { activateIrixPolicy } from "./policy.js";

const logger = pino({ level: "silent" });

describe("Irix providers", () => {
  let deactivate: () => void;
  beforeEach(() => {
    deactivate = activateIrixPolicy();
  });
  afterEach(() => deactivate());

  it("leaves the upstream registry alone until activated", () => {
    deactivate();
    expect(Object.keys(buildProviderRegistry(logger))).toContain("codex");
    deactivate = activateIrixPolicy();
  });

  it("exposes only Claude Code and Devin CLI", () => {
    const registry = buildProviderRegistry(logger);
    expect(Object.keys(registry).sort()).toEqual(["claude", "devin"]);
    expect(registry.devin.label).toBe("Devin CLI");
    expect(registry.devin.enabled).toBe(true);
  });

  it("drops providers a user config tries to add or restore", () => {
    const registry = buildProviderRegistry(logger, {
      providerOverrides: {
        codex: { enabled: true },
        extra: { extends: "acp", label: "Extra", command: ["extra", "acp"] },
      },
    });
    expect(Object.keys(registry).sort()).toEqual(["claude", "devin"]);
  });

  it("lets the user change the Devin command", () => {
    const registry = buildProviderRegistry(logger, {
      providerOverrides: { devin: { command: ["/opt/devin/bin/devin", "acp"] } },
    });
    expect(Object.keys(registry)).toContain("devin");
  });

  it("keeps mock providers in dev builds only", () => {
    expect(Object.keys(buildProviderRegistry(logger, { isDev: true }))).toEqual(
      expect.arrayContaining(["claude", "devin"]),
    );
    expect(Object.keys(buildProviderRegistry(logger, { isDev: false }))).not.toContain("mock");
  });
});
