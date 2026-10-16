import type { SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  getDevinDesktopStatus,
  openInDevinDesktop,
  resolveDevinDesktopInstallation,
  type SpawnedProcess,
} from "./devin-desktop.js";

const SAMPLE_SVG = '<svg width="32" height="32" xmlns="http://www.w3.org/2000/svg"><rect/></svg>';

describe("devin-desktop server integration", () => {
  it("reports not installed when Devin Desktop is absent", () => {
    const status = getDevinDesktopStatus({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
      pathExists: () => false,
    });
    expect(status).toEqual({ installed: false, iconDataUrl: null });
  });

  it("detects Devin.exe under %LOCALAPPDATA%\\Programs\\Devin on Windows and extracts its SVG icon", () => {
    const exePath = "C:\\Users\\alice\\AppData\\Local\\Programs\\Devin\\Devin.exe";
    const iconPath =
      "C:\\Users\\alice\\AppData\\Local\\Programs\\Devin\\resources\\app\\out\\media\\code-icon.svg";
    const existing = new Set([exePath, iconPath]);

    const status = getDevinDesktopStatus({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
      pathExists: (candidate) => existing.has(candidate),
      readFile: (candidate) => {
        expect(candidate).toBe(iconPath);
        return Buffer.from(SAMPLE_SVG, "utf8");
      },
    });

    expect(status.installed).toBe(true);
    expect(status.iconDataUrl).toBe(
      `data:image/svg+xml;base64,${Buffer.from(SAMPLE_SVG, "utf8").toString("base64")}`,
    );
  });

  it("detects Devin.app on macOS and falls back to null iconDataUrl when the icon file is missing", () => {
    const cliPath = "/Applications/Devin.app/Contents/Resources/app/bin/devin-desktop";
    const existing = new Set(["/Applications/Devin.app", cliPath]);

    const status = getDevinDesktopStatus({
      platform: "darwin",
      env: {},
      homeDirectory: "/Users/alice",
      pathExists: (candidate) => existing.has(candidate),
    });

    expect(status).toEqual({ installed: true, iconDataUrl: null });
  });

  it("launches Devin.exe detached with windowsHide on Windows and strips runtime control env vars", async () => {
    const exePath = "C:\\Users\\alice\\AppData\\Local\\Programs\\Devin\\Devin.exe";
    const workspacePath = "C:\\Work\\project";
    const existing = new Set([exePath, workspacePath]);
    const launches: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
    let unrefCalled = false;

    const result = await openInDevinDesktop(workspacePath, {
      platform: "win32",
      env: {
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
        PATH: "C:\\Windows\\System32",
        PASEO_SUPERVISED: "1",
        ELECTRON_RUN_AS_NODE: "1",
      },
      pathExists: (candidate) => existing.has(candidate),
      spawn: (command, args, options) => {
        launches.push({ command, args, options });
        const proc: SpawnedProcess = {
          once(event, handler) {
            if (event === "spawn") {
              (handler as () => void)();
            }
            return proc;
          },
          unref() {
            unrefCalled = true;
          },
        };
        return proc;
      },
    });

    expect(result).toEqual({ ok: true });
    expect(unrefCalled).toBe(true);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.command).toBe(exePath);
    expect(launches[0]?.args).toEqual([workspacePath]);
    expect(launches[0]?.options.detached).toBe(true);
    expect(launches[0]?.options.windowsHide).toBe(true);
    expect(launches[0]?.options.stdio).toBe("ignore");
    expect(launches[0]?.options.env?.PASEO_SUPERVISED).toBeUndefined();
    expect(launches[0]?.options.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(launches[0]?.options.env?.PATH).toBe("C:\\Windows\\System32");
  });

  it("falls back to /usr/bin/open -a on macOS when only the Devin.app bundle exists", () => {
    const existing = new Set(["/Applications/Devin.app"]);
    const installation = resolveDevinDesktopInstallation({
      platform: "darwin",
      env: {},
      homeDirectory: "/Users/alice",
      pathExists: (candidate) => existing.has(candidate),
    });

    expect(installation).not.toBeNull();
    expect(installation?.command).toBe("/usr/bin/open");
    expect(installation?.buildArgs("/Users/alice/repo")).toEqual([
      "-a",
      "/Applications/Devin.app",
      "/Users/alice/repo",
    ]);
  });

  it("rejects relative or non-existent workspace paths", async () => {
    await expect(
      openInDevinDesktop("relative/path", {
        platform: "win32",
        pathExists: () => true,
      }),
    ).rejects.toThrow(/absolute local path/);

    await expect(
      openInDevinDesktop("C:\\Missing\\Repo", {
        platform: "win32",
        pathExists: () => false,
      }),
    ).rejects.toThrow(/does not exist/);
  });
});
