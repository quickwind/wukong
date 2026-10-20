import { win32 } from "node:path";

import {
  type DevinDesktopRuntimeOptions,
  launchDetached,
  requireWorkspaceFolder,
} from "./devin-desktop.js";

/** The program that shows a folder in the system's file manager, or null where there is none. */
export function fileManagerCommand(
  platform: NodeJS.Platform,
  folder: string,
): { command: string; args: string[] } | null {
  switch (platform) {
    case "win32":
      // Explorer opens "Documents" instead when given forward slashes, so normalize them.
      return { command: "explorer.exe", args: [win32.normalize(folder)] };
    case "darwin":
      return { command: "/usr/bin/open", args: [folder] };
    case "linux":
      return { command: "xdg-open", args: [folder] };
    default:
      return null;
  }
}

/** Opens the workspace folder in File Explorer (Windows), Finder (macOS) or the desktop's file manager. */
export async function openInFileManager(
  workspacePath: string,
  options: DevinDesktopRuntimeOptions = {},
): Promise<{ ok: true }> {
  const folder = requireWorkspaceFolder(workspacePath, options);
  const launch = fileManagerCommand(options.platform ?? process.platform, folder);
  if (!launch) {
    throw new Error("Opening a folder is not supported on this system.");
  }
  // A hidden window would hide the Explorer window itself, so unlike a background tool it must show.
  await launchDetached(launch.command, launch.args, { ...options, windowsHide: false });
  return { ok: true };
}
