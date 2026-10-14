// Internal edition: rewrites the `@getpaseo/` npm scope in every tracked text file so the
// release workflow can build and publish the packages under the company's own scope.
// The source keeps `@getpaseo` so upstream merges stay small; run this on a throwaway CI
// checkout only, never commit its result.
//
// Usage: node scripts/rename-npm-scope.mjs --scope <name> [--dry-run]

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_SCOPE = "@getpaseo/";
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

function parseArgs(argv) {
  const args = { scope: "", dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scope") {
      args.scope = (argv[index + 1] ?? "").replace(/^@/u, "");
      index += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!SCOPE_PATTERN.test(args.scope)) {
    throw new Error("--scope is required and must be a lowercase npm scope such as `acme`");
  }
  if (`@${args.scope}/` === UPSTREAM_SCOPE) {
    throw new Error("Refusing to publish under the upstream @getpaseo scope");
  }
  return args;
}

function isBinary(buffer) {
  return buffer.includes(0);
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { scope, dryRun } = parseArgs(process.argv.slice(2));
const replacement = `@${scope}/`;

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: rootDir,
  maxBuffer: 256 * 1024 * 1024,
})
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

let files = 0;
let occurrences = 0;
for (const relativePath of tracked) {
  const absolutePath = path.join(rootDir, relativePath);
  let buffer;
  try {
    buffer = readFileSync(absolutePath);
  } catch {
    continue;
  }
  if (isBinary(buffer)) continue;
  const text = buffer.toString("utf8");
  if (!text.includes(UPSTREAM_SCOPE)) continue;
  const count = text.split(UPSTREAM_SCOPE).length - 1;
  files += 1;
  occurrences += count;
  if (!dryRun) {
    writeFileSync(absolutePath, text.replaceAll(UPSTREAM_SCOPE, replacement));
  }
}

process.stdout.write(
  `${dryRun ? "Would rewrite" : "Rewrote"} ${occurrences} occurrences in ${files} files: ${UPSTREAM_SCOPE} -> ${replacement}\n`,
);
