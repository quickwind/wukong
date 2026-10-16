// The Irix settings file, `<Paseo home>/irix.json`. The daemon's forge adapter and this plugin both
// read its `gitlab` object; the setup screen is the only writer.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandHome } from "../config.js";

export interface GitLabSaved {
  url: string | null;
  configSection: string | null;
  cloneRoot: string | null;
  command: string[] | null;
}

export function irixJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolve(expandHome(env.PASEO_HOME ?? "~/.paseo")), "irix.json");
}

function readDocument(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`, { cause: error });
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/u, ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("the top level must be an object");
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`, { cause: error });
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function commandOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const parts = value.filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? parts : null;
}

export function readGitLabSaved(env: NodeJS.ProcessEnv = process.env): GitLabSaved {
  const gitlab = readDocument(irixJsonPath(env)).gitlab;
  const fields = gitlab && typeof gitlab === "object" ? (gitlab as Record<string, unknown>) : {};
  return {
    url: text(fields.url),
    configSection: text(fields.configSection),
    cloneRoot: text(fields.cloneRoot),
    command: commandOf(fields.command),
  };
}

export function writeGitLabSaved(
  patch: Partial<{ url: string; configSection: string; cloneRoot: string }>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = irixJsonPath(env);
  const document = readDocument(path);
  const existing = document.gitlab;
  const gitlab = existing && typeof existing === "object" ? (existing as object) : {};
  const next = { ...document, gitlab: { ...gitlab, ...patch } };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temp, path);
}
