/* oxlint-disable paseo/no-sync-io -- Irix: small config/credential reads outside the request path. */
// Irix edition: where the bundled ripgrep is. The content search plugin runs `rg`, and an Irix
// machine has none on PATH. Packing (`irix/scripts/fetch-ripgrep.mjs`) puts the binary in the
// plugin's `vendor/<platform>-<arch>/` folder, but the plugin host tells a plugin no folder path,
// so the daemon finds it and passes it on in `IRIX_RG_PATH` (set once at start, see edition.ts).

import { statSync } from "node:fs";
import path from "node:path";
import { resolveBuiltinPluginsRoot } from "../server/plugins/builtin/index.js";

export const IRIX_RG_PATH_ENV = "IRIX_RG_PATH";

export interface BundledRgOptions {
  /** The builtin plugins folder; defaults to the one the daemon loads plugins from. */
  root?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `<plugins>/irix-content-search/vendor/<platform>-<arch>/rg(.exe)` if it exists, else null. */
export function bundledRgPath(options: BundledRgOptions = {}): string | null {
  const root = options.root ?? resolveBuiltinPluginsRoot();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exe = platform === "win32" ? "rg.exe" : "rg";
  const file = path.join(root, "irix-content-search", "vendor", `${platform}-${arch}`, exe);
  return isFile(file) ? file : null;
}

/** Sets `IRIX_RG_PATH` to the bundled binary, unless it is already set or there is none. */
export function applyBundledRgPath(
  env: NodeJS.ProcessEnv = process.env,
  options: BundledRgOptions = {},
): void {
  if (env[IRIX_RG_PATH_ENV]) return;
  const file = bundledRgPath(options);
  if (file) env[IRIX_RG_PATH_ENV] = file;
}
