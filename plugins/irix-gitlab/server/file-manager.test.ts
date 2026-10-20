import type { SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";

import type { SpawnedProcess } from "./devin-desktop.js";
import { fileManagerCommand, openInFileManager } from "./file-manager.js";

function spawnRecorder() {
  const launches: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const spawn = (command: string, args: string[], options: SpawnOptions): SpawnedProcess => {
    launches.push({ command, args, options });
    const proc: SpawnedProcess = {
      once(event, handler) {
        if (event === "spawn") (handler as () => void)();
        return proc;
      },
      unref() {},
    };
    return proc;
  };
  return { launches, spawn };
}

describe("file manager", () => {
  it("picks the system's file manager", () => {
    expect(fileManagerCommand("win32", "C:\\Work\\repo")).toEqual({
      command: "explorer.exe",
      args: ["C:\\Work\\repo"],
    });
    expect(fileManagerCommand("darwin", "/Users/a/repo")?.command).toBe("/usr/bin/open");
    expect(fileManagerCommand("linux", "/home/a/repo")?.command).toBe("xdg-open");
    expect(fileManagerCommand("freebsd", "/x")).toBeNull();
  });

  it("opens File Explorer on the workspace folder, detached, without Paseo's control env", async () => {
    const { launches, spawn } = spawnRecorder();
    const result = await openInFileManager("C:\\Work\\repo", {
      platform: "win32",
      env: { PATH: "C:\\Windows", PASEO_SUPERVISED: "1" },
      pathExists: () => true,
      spawn,
    });

    expect(result).toEqual({ ok: true });
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      command: "explorer.exe",
      args: ["C:\\Work\\repo"],
      options: { detached: true, stdio: "ignore", windowsHide: false },
    });
    expect(launches[0]!.options.env).toEqual({ PATH: "C:\\Windows" });
  });

  it("gives Explorer backslashes, which it needs to open the folder itself", () => {
    expect(fileManagerCommand("win32", "C:/Work/repo")?.args).toEqual(["C:\\Work\\repo"]);
  });

  it("refuses a relative path and a folder that does not exist", async () => {
    const { spawn } = spawnRecorder();
    await expect(
      openInFileManager("repo", { platform: "win32", pathExists: () => true, spawn }),
    ).rejects.toThrow("absolute");
    await expect(
      openInFileManager("C:\\Gone", { platform: "win32", pathExists: () => false, spawn }),
    ).rejects.toThrow("does not exist");
  });
});
