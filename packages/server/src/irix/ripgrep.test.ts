import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBundledRgPath, bundledRgPath, IRIX_RG_PATH_ENV } from "./ripgrep.js";

describe("bundled ripgrep", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "irix-rg-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function placeBinary(key: string, name: string): string {
    const directory = path.join(root, "irix-content-search", "vendor", key);
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    writeFileSync(file, "");
    return file;
  }

  it("names the variable the content search plugin reads", () => {
    expect(IRIX_RG_PATH_ENV).toBe("IRIX_RG_PATH");
  });

  it("finds vendor/<platform>-<arch>/rg under the plugin's folder", () => {
    const file = placeBinary("darwin-arm64", "rg");
    expect(bundledRgPath({ root, platform: "darwin", arch: "arm64" })).toBe(file);
  });

  it("uses rg.exe on Windows", () => {
    const file = placeBinary("win32-x64", "rg.exe");
    expect(bundledRgPath({ root, platform: "win32", arch: "x64" })).toBe(file);
  });

  it("returns null when there is no binary for this platform", () => {
    placeBinary("win32-x64", "rg.exe");
    expect(bundledRgPath({ root, platform: "linux", arch: "x64" })).toBeNull();
  });

  it("defaults to the builtin plugins root of this checkout", () => {
    // The source checkout has no vendor folder, so nothing is found and nothing throws.
    expect(() => bundledRgPath()).not.toThrow();
  });

  it("sets IRIX_RG_PATH when the binary exists", () => {
    const file = placeBinary("linux-x64", "rg");
    const env: NodeJS.ProcessEnv = {};
    applyBundledRgPath(env, { root, platform: "linux", arch: "x64" });
    expect(env.IRIX_RG_PATH).toBe(file);
  });

  it("leaves the variable alone when the binary is absent", () => {
    const env: NodeJS.ProcessEnv = {};
    applyBundledRgPath(env, { root, platform: "linux", arch: "x64" });
    expect("IRIX_RG_PATH" in env).toBe(false);
  });

  it("does not override a value the user set", () => {
    placeBinary("linux-x64", "rg");
    const env: NodeJS.ProcessEnv = { IRIX_RG_PATH: "/opt/my/rg" };
    applyBundledRgPath(env, { root, platform: "linux", arch: "x64" });
    expect(env.IRIX_RG_PATH).toBe("/opt/my/rg");
  });
});
