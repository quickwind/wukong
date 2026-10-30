// Irix edition: a project can keep its workspace config in `.irix.json` instead of `paseo.json`.
//
// Upstream reads, edits and writes one file, `paseo.json`, for worktree setup and teardown,
// terminals and scripts. In the Irix edition `.irix.json` in the same folder is that file when it
// exists, and `paseo.json` is then not read at all. With no `.irix.json` nothing changes. Upstream's
// `resolvePaseoConfigPath` asks here, so every reader and the writer (the scripts list, worktree
// setup, the untrusted-source check, the project config editor and its Setup tab) use the same file.

import { stat } from "node:fs/promises";
import path from "node:path";
import { isIrixActive } from "./policy.js";

export const IRIX_CONFIG_FILE_NAME = ".irix.json";

/** The path of `.irix.json` in `repoRoot` when the Irix edition is on and the file exists. */
export async function irixConfigPath(repoRoot: string): Promise<string | null> {
  if (!isIrixActive()) {
    return null;
  }
  const configPath = path.join(path.resolve(repoRoot), IRIX_CONFIG_FILE_NAME);
  try {
    await stat(configPath);
    return configPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    // Any other failure (permissions, a broken link) is reported by the reader, under this path.
    return configPath;
  }
}
