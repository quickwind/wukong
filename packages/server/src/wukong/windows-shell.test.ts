import { afterEach, describe, expect, it } from "vitest";

import { activateWukongPolicy } from "./policy.js";
import { wukongWindowsShell } from "./windows-shell.js";

describe("wukongWindowsShell", () => {
  let deactivate: (() => void) | undefined;
  afterEach(() => deactivate?.());

  it("leaves the choice to upstream outside the Wukong edition", () => {
    expect(wukongWindowsShell({})).toBeUndefined();
  });

  it("defaults to PowerShell and honours WUKONG_WINDOWS_SHELL=cmd", () => {
    deactivate = activateWukongPolicy();
    expect(wukongWindowsShell({})).toBe("powershell");
    expect(wukongWindowsShell({ WUKONG_WINDOWS_SHELL: "CMD" })).toBe("cmd");
    expect(wukongWindowsShell({ WUKONG_WINDOWS_SHELL: "bash" })).toBe("powershell");
  });
});
