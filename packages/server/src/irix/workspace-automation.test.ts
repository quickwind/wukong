import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { activateIrixPolicy } from "./policy.js";
import { hasWorkspaceAutomation } from "./workspace-automation.js";

function checkout(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "irix-automation-"));
  if (config !== undefined) writeFileSync(join(dir, "paseo.json"), config);
  return dir;
}

describe("hasWorkspaceAutomation", () => {
  let deactivate: (() => void) | undefined;
  afterEach(() => deactivate?.());

  it("keeps Paseo's behaviour (always blocks) until Irix is active", async () => {
    expect(await hasWorkspaceAutomation(checkout())).toBe(true);
  });

  it("is false for a checkout with no paseo.json or one with nothing to run", async () => {
    deactivate = activateIrixPolicy();
    expect(await hasWorkspaceAutomation(checkout())).toBe(false);
    expect(await hasWorkspaceAutomation(checkout('{"worktree":{"setup":[]},"scripts":{}}'))).toBe(
      false,
    );
  });

  it("is true for setup, teardown, terminals or scripts", async () => {
    deactivate = activateIrixPolicy();
    expect(await hasWorkspaceAutomation(checkout('{"worktree":{"setup":"npm i"}}'))).toBe(true);
    expect(await hasWorkspaceAutomation(checkout('{"worktree":{"teardown":["rm -rf x"]}}'))).toBe(
      true,
    );
    expect(
      await hasWorkspaceAutomation(
        checkout('{"worktree":{"terminals":[{"command":"npm run dev"}]}}'),
      ),
    ).toBe(true);
    expect(
      await hasWorkspaceAutomation(checkout('{"scripts":{"web":{"command":"npm start"}}}')),
    ).toBe(true);
  });

  it("keeps the block when paseo.json cannot be read", async () => {
    deactivate = activateIrixPolicy();
    expect(await hasWorkspaceAutomation(checkout("{ not json"))).toBe(true);
  });
});
