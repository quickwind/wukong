import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRgBinary } from "./rg-binary.js";

function existsIn(paths: string[]) {
  const set = new Set(paths);
  return (p: string) => set.has(p);
}

describe("resolveRgBinary", () => {
  it("prefers the bundled binary for the platform and arch", () => {
    const bundled = path.posix.join("/plugin", "vendor", "darwin-arm64", "rg");
    const result = resolveRgBinary({
      pluginDir: "/plugin",
      platform: "darwin",
      arch: "arm64",
      pathEnv: "/usr/bin:/opt/homebrew/bin",
      exists: existsIn([bundled, "/opt/homebrew/bin/rg"]),
    });
    expect(result).toBe(bundled);
  });

  it("falls back to the first rg on PATH", () => {
    const result = resolveRgBinary({
      pluginDir: "/plugin",
      platform: "linux",
      arch: "x64",
      pathEnv: "/usr/local/bin::/usr/bin:/opt/bin",
      exists: existsIn(["/usr/bin/rg", "/opt/bin/rg"]),
    });
    expect(result).toBe("/usr/bin/rg");
  });

  it("uses rg.exe and ; separators on Windows", () => {
    const bundled = path.win32.join("C:\\irix\\plugin", "vendor", "win32-x64", "rg.exe");
    expect(
      resolveRgBinary({
        pluginDir: "C:\\irix\\plugin",
        platform: "win32",
        arch: "x64",
        pathEnv: "C:\\Windows;C:\\tools",
        exists: existsIn([bundled]),
      }),
    ).toBe(bundled);
    expect(
      resolveRgBinary({
        pluginDir: "C:\\irix\\plugin",
        platform: "win32",
        arch: "x64",
        pathEnv: 'C:\\Windows;"C:\\Program Files\\rg"',
        exists: existsIn(["C:\\Program Files\\rg\\rg.exe"]),
      }),
    ).toBe("C:\\Program Files\\rg\\rg.exe");
  });

  it("returns null when neither the bundled binary nor PATH has rg", () => {
    expect(
      resolveRgBinary({
        pluginDir: "/plugin",
        platform: "linux",
        arch: "x64",
        pathEnv: "/usr/bin",
        exists: () => false,
      }),
    ).toBeNull();
  });

  it("works without a plugin directory", () => {
    expect(
      resolveRgBinary({
        platform: "linux",
        arch: "x64",
        pathEnv: "/usr/bin",
        exists: existsIn(["/usr/bin/rg"]),
      }),
    ).toBe("/usr/bin/rg");
  });
});
