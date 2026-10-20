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
      return { command: "explorer.exe", args: [folder] };
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
  await launchDetached(launch.command, launch.args, options);
  return { ok: true };
}
