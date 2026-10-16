import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCloneRoot, loadSettings } from "./config.js";

describe("defaultCloneRoot", () => {
  it("is the workspace\\gitlab folder under the home folder on Windows", () => {
    expect(defaultCloneRoot("win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\workspace\\gitlab");
  });

  it.each(["darwin", "linux"] as const)("is ~/workspace/gitlab on %s", (platform) => {
    expect(defaultCloneRoot(platform, "/home/me")).toBe("~/workspace/gitlab");
  });
});

describe("loadSettings", () => {
  const home = mkdtempSync(join(tmpdir(), "irix-config-"));

  it("clones into the default folder when nothing is configured", () => {
    const settings = loadSettings({ PASEO_HOME: home, IRIX_GITLAB_URL: "https://gl.example.com" });
    const expected =
      process.platform === "win32"
        ? defaultCloneRoot("win32", homedir())
        : resolve(homedir(), "workspace", "gitlab");
    expect(settings.cloneRoot).toBe(resolve(expected.replace(/^~[\\/]/u, `${homedir()}/`)));
  });

  it("lets IRIX_CLONE_ROOT win", () => {
    const settings = loadSettings({
      PASEO_HOME: home,
      IRIX_GITLAB_URL: "https://gl.example.com",
      IRIX_CLONE_ROOT: "/srv/clones",
    });
    expect(settings.cloneRoot).toBe(resolve("/srv/clones"));
  });
});
