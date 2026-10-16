import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "node:fs";
import os from "node:os";
import { posix, win32 } from "node:path";

export interface SpawnedProcess {
  once(event: "error", handler: (error: Error) => void): SpawnedProcess;
  once(event: "spawn", handler: () => void): SpawnedProcess;
  unref(): void;
}

export interface DevinDesktopRuntimeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  pathExists?: (targetPath: string) => boolean;
  readFile?: (targetPath: string) => Buffer;
  spawn?: (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;
}

export interface DevinDesktopInstallation {
  command: string;
  buildArgs: (workspacePath: string) => string[];
  iconPath: string;
}

const RUNTIME_CONTROL_ENV_KEYS = [
  "PASEO_NODE_ENV",
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
] as const;

const MAX_ICON_BYTES = 64 * 1024;

function sanitizeEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  return env;
}

function isAbsolutePath(targetPath: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? win32.isAbsolute(targetPath) : posix.isAbsolute(targetPath);
}

function spawnProcess(command: string, args: string[], options: SpawnOptions): SpawnedProcess {
  return nodeSpawn(command, args, options) as ChildProcess as SpawnedProcess;
}

export function resolveDevinDesktopInstallation(
  options: DevinDesktopRuntimeOptions = {},
): DevinDesktopInstallation | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const pathExists = options.pathExists ?? nodeExistsSync;

  if (platform === "win32") {
    const roots = [
      env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs` : null,
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
    ];
    for (const root of roots) {
      if (!root) continue;
      const installDir = `${root.replace(/[\\/]+$/u, "")}\\Devin`;
      const exePath = `${installDir}\\Devin.exe`;
      if (pathExists(exePath)) {
        return {
          command: exePath,
          buildArgs: (workspacePath) => [workspacePath],
          iconPath: `${installDir}\\resources\\app\\out\\media\\code-icon.svg`,
        };
      }
    }
    return null;
  }

  if (platform === "darwin") {
    const appBundles = [
      "/Applications/Devin.app",
      homeDirectory ? `${homeDirectory.replace(/\/+$/u, "")}/Applications/Devin.app` : null,
    ];
    for (const appBundle of appBundles) {
      if (!appBundle) continue;
      const cliPath = `${appBundle}/Contents/Resources/app/bin/devin-desktop`;
      const iconPath = `${appBundle}/Contents/Resources/app/out/media/code-icon.svg`;
      if (pathExists(cliPath)) {
        return {
          command: cliPath,
          buildArgs: (workspacePath) => [workspacePath],
          iconPath,
        };
      }
      if (pathExists(appBundle)) {
        return {
          command: "/usr/bin/open",
          buildArgs: (workspacePath) => ["-a", appBundle, workspacePath],
          iconPath,
        };
      }
    }
  }

  return null;
}

export function readDevinIconDataUrl(
  iconPath: string,
  options: Pick<DevinDesktopRuntimeOptions, "pathExists" | "readFile"> = {},
): string | null {
  const pathExists = options.pathExists ?? nodeExistsSync;
  const readFile = options.readFile ?? nodeReadFileSync;
  if (!pathExists(iconPath)) {
    return null;
  }
  try {
    const bytes = readFile(iconPath);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) {
      return null;
    }
    const head = bytes.subarray(0, 256).toString("utf8");
    if (!head.includes("<svg")) {
      return null;
    }
    return `data:image/svg+xml;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export function getDevinDesktopStatus(options: DevinDesktopRuntimeOptions = {}): {
  installed: boolean;
  iconDataUrl: string | null;
} {
  const installation = resolveDevinDesktopInstallation(options);
  if (!installation) {
    return { installed: false, iconDataUrl: null };
  }
  return {
    installed: true,
    iconDataUrl: readDevinIconDataUrl(installation.iconPath, options),
  };
}

export async function openInDevinDesktop(
  workspacePath: string,
  options: DevinDesktopRuntimeOptions = {},
): Promise<{ ok: true }> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? nodeExistsSync;
  const spawn = options.spawn ?? spawnProcess;

  const trimmed = workspacePath.trim();
  if (!trimmed || !isAbsolutePath(trimmed, platform)) {
    throw new Error("Workspace path must be an absolute local path.");
  }
  if (!pathExists(trimmed)) {
    throw new Error(`Workspace path does not exist: ${trimmed}`);
  }

  const installation = resolveDevinDesktopInstallation(options);
  if (!installation) {
    throw new Error("Devin Desktop is not installed.");
  }

  const args = installation.buildArgs(trimmed);
  await new Promise<void>((resolve, reject) => {
    let child: SpawnedProcess;
    try {
      child = spawn(installation.command, args, {
        detached: true,
        env: sanitizeEnv(env),
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

  return { ok: true };
}
