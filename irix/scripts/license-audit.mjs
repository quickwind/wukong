// Which licenses does what we ship depend on? Walks the production dependencies of the seven
// published packages in package-lock.json and sorts each package's license into:
//   ok       permissive (MIT, ISC, BSD, Apache-2.0, ...), or an OR with a permissive choice
//   review   weak copyleft or attribution licenses (LGPL, MPL, EPL, CC-BY) and unknown licenses:
//            allowed only after a person has looked (see IRIX.md, "License and attribution")
//   blocked  strong copyleft or restricted licenses (GPL, AGPL, SSPL, BUSL, non-commercial,
//            UNLICENSED): do not ship these
// Build-time tools and dev dependencies are not walked: they are not in the tarballs.
//
//   node irix/scripts/license-audit.mjs [--since <ref>] [--lock package-lock.json]
//
// --since lists only packages the lockfile gained since <ref> (what a change or sync added).
// Exits 1 if any shipped package is `blocked`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SHIPPED = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];
const PERMISSIVE = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Apache-2.0",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "Zlib",
  "WTFPL",
]);
const BLOCKED =
  /\bA?GPL\b|\bA?GPL-|SSPL|BUSL|Commons-Clause|NonCommercial|UNLICENSED|proprietary/iu;

/** `MIT`, `(MIT OR GPL-3.0)`, `Apache-2.0 AND LGPL-3.0-or-later`: the worst reading that applies. */
export function classify(expression) {
  if (!expression) return "review";
  const text = expression.replace(/[()]/gu, " ").trim();
  if (/\sOR\s/u.test(text)) {
    const rank = new Set(text.split(/\sOR\s/u).map((part) => classify(part)));
    return ["ok", "review", "blocked"].find((level) => rank.has(level));
  }
  const parts = text.split(/\sAND\s/u).map((part) => part.trim());
  const levels = new Set(
    parts.map((part) => {
      if (BLOCKED.test(part) && !part.startsWith("LGPL")) return "blocked";
      return PERMISSIVE.has(part) ? "ok" : "review";
    }),
  );
  return ["blocked", "review", "ok"].find((level) => levels.has(level));
}

function resolve(packages, from, name) {
  let directory = from;
  for (;;) {
    const candidate = `${directory ? `${directory}/` : ""}node_modules/${name}`;
    if (packages[candidate]) {
      const entry = packages[candidate];
      return entry.link && packages[entry.resolved] ? entry.resolved : candidate;
    }
    if (!directory) return null;
    const cut = directory.lastIndexOf("/node_modules/");
    directory = cut === -1 ? "" : directory.slice(0, cut);
  }
}

export function shippedPackages(lock) {
  const packages = lock.packages;
  const seen = new Map();
  const queue = SHIPPED.map((name) => `packages/${name}`).filter((key) => packages[key]);
  while (queue.length > 0) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    const entry = packages[key];
    seen.set(key, entry);
    const dependencies = { ...entry.dependencies, ...entry.optionalDependencies };
    for (const name of Object.keys(dependencies)) {
      const found = resolve(packages, key, name);
      if (found) queue.push(found);
    }
  }
  // Drop the workspaces themselves, not the dependencies installed inside them.
  return [...seen].filter(([key]) => key.includes("node_modules/"));
}

export function audit(lock, since) {
  const sinceKeys = since ? new Set(Object.keys(since.packages)) : null;
  const rows = [];
  for (const [key, entry] of shippedPackages(lock)) {
    if (sinceKeys?.has(key)) continue;
    const name = key.replace(/^.*node_modules\//u, "");
    const license = typeof entry.license === "string" ? entry.license : undefined;
    rows.push({
      name,
      version: entry.version,
      license: license ?? "(none)",
      level: classify(license),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > -1 ? process.argv[index + 1] : undefined;
  };
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const lockPath = path.resolve(arg("lock") ?? path.join(repo, "package-lock.json"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const ref = arg("since");
  const since = ref
    ? JSON.parse(
        execFileSync("git", ["show", `${ref}:package-lock.json`], {
          cwd: repo,
          encoding: "utf8",
          maxBuffer: 1 << 28,
        }),
      )
    : null;
  const rows = audit(lock, since);
  const count = (level) => rows.filter((row) => row.level === level).length;
  console.log(
    `${ref ? `new since ${ref}: ` : ""}${rows.length} shipped packages: ${count("ok")} ok, ${count("review")} review, ${count("blocked")} blocked`,
  );
  for (const level of ["blocked", "review"]) {
    for (const row of rows.filter((entry) => entry.level === level)) {
      console.log(`  ${level.padEnd(7)} ${row.name}@${row.version}  ${row.license}`);
    }
  }
  process.exit(count("blocked") > 0 ? 1 : 0);
}
