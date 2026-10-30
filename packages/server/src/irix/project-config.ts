// Irix edition: a project can keep its Irix scripts in `.irix.json`, next to `paseo.json`.
//
// Upstream reads one file, `paseo.json`, for worktree setup and teardown, terminals and scripts.
// Irix also reads `.irix.json` from the same folder, and it has priority: a script with the same
// name comes from `.irix.json`, scripts with other names come from both files, and a top-level
// key such as `worktree` that `.irix.json` sets replaces the one in `paseo.json`. A project that
// has only `paseo.json` (or only `.irix.json`) behaves as before. Upstream's editor and its Setup
// tab still read and write only `paseo.json`; `.irix.json` is edited by hand.
//
// Only the runtime read goes through here (`readPaseoConfig` in utils/paseo-config-file.ts), so
// scripts, worktree setup and the untrusted-source check all see the merged file.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PaseoConfigSchema, type PaseoConfig } from "@getpaseo/protocol/paseo-config-schema";
import type { ReadPaseoConfigResult } from "../utils/paseo-config-file.js";
import { isIrixActive } from "./policy.js";

export const IRIX_CONFIG_FILE_NAME = ".irix.json";
const MAX_IRIX_CONFIG_BYTES = 256 * 1024;

interface CachedConfig {
  mtimeMs: number;
  size: number;
  result: { ok: true; config: PaseoConfig } | { ok: false; error: unknown };
}

const cache = new Map<string, CachedConfig>();

async function readIrixConfig(
  configPath: string,
): Promise<{ ok: true; config: PaseoConfig } | { ok: false; error: unknown } | null> {
  let stats;
  try {
    stats = await stat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      cache.delete(configPath);
      return null;
    }
    return { ok: false, error };
  }
  if (!stats.isFile() || stats.size > MAX_IRIX_CONFIG_BYTES) {
    return {
      ok: false,
      error: new Error(
        `${IRIX_CONFIG_FILE_NAME} must be a regular file of at most ${MAX_IRIX_CONFIG_BYTES} bytes`,
      ),
    };
  }
  const cached = cache.get(configPath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached.result;
  }
  let result: CachedConfig["result"];
  try {
    const json: unknown = JSON.parse(await readFile(configPath, "utf8"));
    result = { ok: true, config: PaseoConfigSchema.parse(json) };
  } catch (error) {
    result = { ok: false, error };
  }
  cache.set(configPath, { mtimeMs: stats.mtimeMs, size: stats.size, result });
  return result;
}

export function mergeProjectConfigs(base: PaseoConfig | null, irix: PaseoConfig): PaseoConfig {
  const merged: PaseoConfig = { ...base, ...irix };
  if (base?.scripts || irix.scripts) {
    merged.scripts = { ...base?.scripts, ...irix.scripts };
  }
  return merged;
}

/** Adds `.irix.json` to what `readPaseoConfig` found. Changes nothing outside the Irix edition. */
export async function withIrixProjectConfig(
  repoRoot: string,
  found: ReadPaseoConfigResult,
): Promise<ReadPaseoConfigResult> {
  if (!isIrixActive()) {
    return found;
  }
  const configPath = path.join(path.resolve(repoRoot), IRIX_CONFIG_FILE_NAME);
  const irix = await readIrixConfig(configPath);
  if (irix === null) {
    return found;
  }
  if (!irix.ok) {
    return { ok: false, configPath, error: irix.error };
  }
  if (!found.ok) {
    // A broken paseo.json stays visible; merging over it would hide the problem.
    return found;
  }
  return { ok: true, config: mergeProjectConfigs(found.config, irix.config) };
}

export function resetIrixProjectConfigForTests(): void {
  cache.clear();
}
