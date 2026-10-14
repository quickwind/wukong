import { afterEach, describe, expect, it } from "vitest";

import { activateIrixPolicy } from "./policy.js";
import { irixWindowsShell } from "./windows-shell.js";

describe("irixWindowsShell", () => {
  let deactivate: (() => void) | undefined;
  afterEach(() => deactivate?.());

  it("leaves the choice to upstream outside the Irix edition", () => {
    expect(irixWindowsShell({})).toBeUndefined();
  });

  it("defaults to PowerShell and honours IRIX_WINDOWS_SHELL=cmd", () => {
    deactivate = activateIrixPolicy();
    expect(irixWindowsShell({})).toBe("powershell");
    expect(irixWindowsShell({ IRIX_WINDOWS_SHELL: "CMD" })).toBe("cmd");
    expect(irixWindowsShell({ IRIX_WINDOWS_SHELL: "bash" })).toBe("powershell");
  });
});
