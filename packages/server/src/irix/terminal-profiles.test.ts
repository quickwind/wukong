import { afterEach, describe, expect, it } from "vitest";

import { activateIrixPolicy } from "./policy.js";
import { irixTerminalProfiles, wukongTerminalProfiles } from "./terminal-profiles.js";

describe("irixTerminalProfiles", () => {
  let deactivate: (() => void) | undefined;
  afterEach(() => deactivate?.());

  const custom = [{ id: "mine", name: "Mine", command: "mine" }];

  it("leaves the configured profiles alone until Irix is active", () => {
    expect(irixTerminalProfiles(custom)).toBe(custom);
    expect(irixTerminalProfiles(undefined)).toBeUndefined();
    expect(wukongTerminalProfiles(custom)).toBe(custom);
  });

  it("is Claude Code alone once active, ignoring configured profiles", () => {
    deactivate = activateIrixPolicy();
    for (const configured of [undefined, custom]) {
      expect(irixTerminalProfiles(configured)?.map((profile) => profile.id)).toEqual(["claude"]);
      expect(wukongTerminalProfiles(configured)?.map((profile) => profile.id)).toEqual(["claude"]);
    }
  });
});
