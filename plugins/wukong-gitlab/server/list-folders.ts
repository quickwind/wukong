// Backs the Open folder screen: the folders inside one folder, plus the places people start from.
// The daemon listens on loopback only, so the disk it reads is the one the user is sitting at.

import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface FolderListing {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
  shortcuts: { label: string; path: string }[];
}

export interface ListFoldersEnv {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exists(path: string): boolean;
}

const defaultEnv = (): ListFoldersEnv => ({
  platform: process.platform,
  home: homedir(),
  env: process.env,
  exists: existsSync,
});

export function shortcutsFor(env: ListFoldersEnv): FolderListing["shortcuts"] {
  const join = env.platform === "win32" ? path.win32.join : path.posix.join;
  const candidates = [
    { label: "Home", path: env.home },
    { label: "Desktop", path: join(env.home, "Desktop") },
    { label: "Documents", path: join(env.home, "Documents") },
    { label: "Downloads", path: join(env.home, "Downloads") },
    { label: "OneDrive", path: env.env.OneDrive ?? env.env.OneDriveCommercial ?? "" },
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate.path || seen.has(candidate.path) || !env.exists(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

function windowsDrives(env: ListFoldersEnv): FolderListing["folders"] {
  const drives: FolderListing["folders"] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (env.exists(root)) drives.push({ name: root, path: root });
  }
  return drives;
}

/** The folder above `directory`, or null when it is a top (`/`, `C:\`). */
function parentOf(directory: string, platform: NodeJS.Platform): string | null {
  const lib = platform === "win32" ? path.win32 : path.posix;
  const parent = lib.dirname(directory);
  if (parent !== directory) return parent;
  return platform === "win32" ? "" : null;
}

/**
 * `requested` undefined means the home folder. On Windows the empty string means the drive list.
 * Hidden folders and ones the user cannot read are left out; a missing or unreadable `requested`
 * throws so the screen can say so.
 */
export async function listFolders(
  requested: string | undefined,
  env: ListFoldersEnv = defaultEnv(),
): Promise<FolderListing> {
  const shortcuts = shortcutsFor(env);
  if (env.platform === "win32" && requested === "") {
    return { path: "", parent: null, folders: windowsDrives(env), shortcuts };
  }
  const lib = env.platform === "win32" ? path.win32 : path.posix;
  const target = lib.resolve(requested === undefined ? env.home : requested.trim() || env.home);
  if (!(await stat(target)).isDirectory()) {
    throw new Error(`${target} is not a folder`);
  }
  const entries = await readdir(target, { withFileTypes: true });
  const folders = entries
    .filter(
      (entry) =>
        !entry.name.startsWith(".") && (entry.isDirectory() || isLinkToFolder(entry, target, lib)),
    )
    .map((entry) => ({ name: entry.name, path: lib.join(target, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { path: target, parent: parentOf(target, env.platform), folders, shortcuts };
}

function isLinkToFolder(
  entry: { name: string; isSymbolicLink(): boolean },
  directory: string,
  lib: typeof path.posix,
): boolean {
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(lib.join(directory, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

// Characters Windows refuses in a name; they are refused everywhere so a folder made here can be
// opened on any machine the project is shared with.
const INVALID_NAME = /[<>:"/\\|?*]/u;
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

export function folderNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name for the folder";
  if (trimmed === "." || trimmed === "..") return "That is not a usable folder name";
  if (INVALID_NAME.test(trimmed) || [...trimmed].some((char) => char.charCodeAt(0) < 32))
    return 'A folder name cannot contain \\ / : * ? " < > |';
  if (/[. ]$/u.test(trimmed)) return "A folder name cannot end with a dot or a space";
  if (RESERVED_WINDOWS_NAME.test(trimmed)) return `${trimmed} is reserved by Windows`;
  return null;
}

/** Makes one new folder inside an existing one. Refuses a name that already exists. */
export async function createFolder(
  parent: string,
  name: string,
  env: Pick<ListFoldersEnv, "platform"> = { platform: process.platform },
): Promise<{ path: string }> {
  const problem = folderNameProblem(name);
  if (problem) throw new Error(problem);
  const lib = env.platform === "win32" ? path.win32 : path.posix;
  const target = lib.join(lib.resolve(parent), name.trim());
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${name.trim()} already exists here`, { cause: error });
    }
    throw error;
  }
  return { path: target };
}
