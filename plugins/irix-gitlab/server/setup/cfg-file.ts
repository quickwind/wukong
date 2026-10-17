// Reads and edits python-gitlab's config file (`~/.python-gitlab.cfg`). The file is edited line by
// line instead of through an INI library, so comments, line endings and other sections survive.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CfgSection {
  name: string;
  url: string | null;
}

const SECTION_HEADER = /^﻿?\s*\[([^\]]+)\]\s*$/u;
const URL_LINE = /^\s*url\s*[=:]\s*(.*?)\s*$/iu;
const URL_KEY = /^\s*url\s*[=:]/iu;
const TOKEN_KEY = /^\s*private_token\s*[=:]/iu;

export function cfgPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PYTHON_GITLAB_CFG?.trim();
  return override || join(homedir(), ".python-gitlab.cfg");
}

/** Lines with their terminators kept, so a rewrite reproduces the file exactly. */
function splitLines(text: string): string[] {
  return text.split(/(?<=\n)/u).filter((line) => line.length > 0);
}

function headerName(line: string): string | null {
  return SECTION_HEADER.exec(line.replace(/\r?\n$/u, ""))?.[1]?.trim() ?? null;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function readCfgSections(path: string): CfgSection[] {
  const sections: CfgSection[] = [];
  let current: CfgSection | null = null;
  for (const raw of splitLines(readText(path))) {
    const line = raw.replace(/\r?\n$/u, "");
    const name = headerName(line);
    if (name !== null) {
      current = name === "global" ? null : { name, url: null };
      if (current) sections.push(current);
      continue;
    }
    const url = current ? URL_LINE.exec(line)?.[1] : undefined;
    if (current && url) current.url = url;
  }
  return sections;
}

export function freeSectionName(existing: string[], base = "irix"): string {
  const taken = new Set([...existing, "global"]);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function assertCfgValue(label: string, value: string): void {
  if (!value) throw new Error(`The ${label} must not be empty`);
  if (hasControlCharacter(value)) {
    throw new Error(`The ${label} must not contain control characters or line breaks`);
  }
  if (value !== value.trim()) {
    throw new Error(`The ${label} must not start or end with a space`);
  }
}

function withTerminator(line: string, eol: string): string {
  return line.endsWith("\n") ? line : `${line}${eol}`;
}

function replaceInSection(
  lines: string[],
  start: number,
  end: number,
  section: { url: string; token: string },
  eol: string,
): string[] {
  const body = lines.slice(start + 1, end);
  let sawUrl = false;
  let sawToken = false;
  const rewritten = body.map((line) => {
    const terminator = /\r?\n$/u.exec(line)?.[0] ?? eol;
    if (URL_KEY.test(line)) {
      sawUrl = true;
      return `url = ${section.url}${terminator}`;
    }
    if (TOKEN_KEY.test(line)) {
      sawToken = true;
      return `private_token = ${section.token}${terminator}`;
    }
    return line;
  });
  const additions = [
    ...(sawUrl ? [] : [`url = ${section.url}${eol}`]),
    ...(sawToken ? [] : [`private_token = ${section.token}${eol}`]),
  ];
  if (additions.length > 0) {
    // Insert straight after the header so trailing blank lines stay where they were.
    rewritten.unshift(...additions);
  }
  return [...lines.slice(0, start + 1), ...rewritten, ...lines.slice(end)];
}

/**
 * Adds a section, or updates the url and token of an existing one. Everything else in the file is
 * left as it was. A `[global] default` is written only for a file with no sections at all, so a
 * user's own default is never replaced.
 */
export function upsertSection(
  path: string,
  section: { name: string; url: string; token: string },
): void {
  const text = readText(path);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let lines = splitLines(text);

  const headers = lines
    .map((line, index) => ({ name: headerName(line), index }))
    .filter((entry): entry is { name: string; index: number } => entry.name !== null);
  const found = headers.findIndex((entry) => entry.name === section.name);

  if (found >= 0) {
    const start = headers[found]?.index ?? 0;
    const end = headers[found + 1]?.index ?? lines.length;
    lines = replaceInSection(lines, start, end, section, eol);
  } else {
    if (lines.length > 0) {
      const last = lines.length - 1;
      lines[last] = withTerminator(lines[last] ?? "", eol);
      lines.push(eol);
    } else {
      lines.push(`[global]${eol}`, `default = ${section.name}${eol}`, eol);
    }
    lines.push(
      `[${section.name}]${eol}`,
      `url = ${section.url}${eol}`,
      `private_token = ${section.token}${eol}`,
      `api_version = 4${eol}`,
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, lines.join(""), { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Windows has no POSIX modes.
  }
  renameSync(temp, path);
}
