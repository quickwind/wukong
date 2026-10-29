import { describe, expect, it } from "vitest";
import { isWithinFolders } from "./workspace-folders.js";

describe("isWithinFolders", () => {
  it("accepts the folder itself and folders inside it", () => {
    expect(isWithinFolders("/work/app", ["/work/app"], "linux")).toBe(true);
    expect(isWithinFolders("/work/app/src/", ["/other", "/work/app"], "linux")).toBe(true);
    expect(isWithinFolders("/work/app/..app/x", ["/work/app"], "linux")).toBe(true);
  });

  it("rejects siblings, parents and escapes", () => {
    expect(isWithinFolders("/work/app2", ["/work/app"], "linux")).toBe(false);
    expect(isWithinFolders("/work", ["/work/app"], "linux")).toBe(false);
    expect(isWithinFolders("/work/app/../secret", ["/work/app"], "linux")).toBe(false);
    expect(isWithinFolders("/work/app", [], "linux")).toBe(false);
  });

  it("ignores letter case and slash direction on Windows", () => {
    expect(isWithinFolders("c:/Work/App/src", ["C:\\work\\app"], "win32")).toBe(true);
    expect(isWithinFolders("D:\\work\\app", ["C:\\work\\app"], "win32")).toBe(false);
  });
});
