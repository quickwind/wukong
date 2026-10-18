// Irix: fixes to upstream's build scripts that only matter on Windows. Applied to the throwaway
// checkout that pack-local builds, never committed, so upstream's files stay as they are (the same
// idea as brand.mjs).
//
// Every fix must find what it expects. When upstream changes or fixes the target, the run says
// which fix to look at instead of silently doing nothing; a target that already has the fix is
// left alone.
//
// Usage: node irix/scripts/build-fixes.mjs [--root <dir>] [--dry-run]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const FIXES = [
  {
    // `npm` is `npm.cmd` on Windows, which only a shell can start: this script's spawn fails there
    // with "spawn npm ENOENT" when it builds the web UI.
    file: "scripts/build-daemon-web-ui.mjs",
    pattern: /shell: false,/u,
    replacement: 'shell: process.platform === "win32",',
    applied: 'process.platform === "win32"',
  },
  {
    // Metro keeps a transform cache in the system temp folder, shared by every checkout. It is
    // keyed on file contents, not on EXPO_PUBLIC_* variables, so a new EXPO_PUBLIC_IRIX_VERSION
    // was ignored and About showed the version of an earlier pack. `--clear` skips the cache.
    file: "packages/app/package.json",
    pattern: /expo export --platform web"/u,
    replacement: 'expo export --platform web --clear"',
    applied: "expo export --platform web --clear",
  },
];

export function applyBuildFixes({ root = REPO_ROOT, dryRun = false, log = () => {} } = {}) {
  for (const fix of FIXES) {
    const target = path.join(root, fix.file);
    if (!existsSync(target)) throw new Error(`Build fix target is missing: ${fix.file}`);
    const text = readFileSync(target, "utf8");
    if (text.includes(fix.applied)) continue;
    if (!fix.pattern.test(text)) {
      throw new Error(
        `Build fix found nothing to change in ${fix.file} (${fix.pattern}). ` +
          "Upstream changed it: check whether the fix is still needed.",
      );
    }
    log(`fix     ${fix.file}`);
    if (!dryRun) writeFileSync(target, text.replace(fix.pattern, fix.replacement));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--root");
  const root = index === -1 ? REPO_ROOT : path.resolve(args[index + 1] ?? "");
  applyBuildFixes({
    root,
    dryRun: args.includes("--dry-run"),
    log: (line) => process.stdout.write(`${line}\n`),
  });
}
