import { statSync } from "node:fs";
import path from "node:path";

export interface ResolveRgBinaryOptions {
  /** The plugin's folder; a bundled binary lives at `vendor/<platform>-<arch>/rg(.exe)`. */
  pluginDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  pathEnv?: string;
  exists?: (p: string) => boolean;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The bundled `rg`, else the first `rg` on PATH, else null. */
export function resolveRgBinary(options: ResolveRgBinaryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? isFile;
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const exe = windows ? "rg.exe" : "rg";

  if (options.pluginDir) {
    const bundled = paths.join(options.pluginDir, "vendor", `${platform}-${arch}`, exe);
    if (exists(bundled)) return bundled;
  }

  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  for (const raw of pathEnv.split(windows ? ";" : ":")) {
    // Windows PATH entries may be quoted.
    const dir = windows ? raw.trim().replace(/^"(.*)"$/, "$1") : raw;
    if (dir.length === 0) continue;
    const candidate = paths.join(dir, exe);
    if (exists(candidate)) return candidate;
  }
  return null;
}
