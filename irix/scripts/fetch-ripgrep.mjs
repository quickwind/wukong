// Irix: downloads the pinned ripgrep release for the content search plugin, checks each file's
// SHA-256 and puts the binary in `<destRoot>/vendor/<platform>-<arch>/rg` (`rg.exe` on Windows),
// with ripgrep's COPYING, LICENSE-MIT and UNLICENSE beside it. pack-local.mjs runs it in the
// throwaway checkout, so the binary is never committed; the installed daemon never runs it.
//
// ripgrep: https://github.com/BurntSushi/ripgrep, MIT or Unlicense, by Andrew Gallant.
//
// Extraction uses the system's tools. bsdtar (macOS, and `tar.exe` on Windows 10+) reads both
// .tar.gz and .zip; GNU tar (Linux, Git Bash) does not read zip, so `unzip` is tried after it.
// Archives are named bare and the tool runs in their folder: GNU tar reads `C:\...` as host:file.
//
// Usage: node irix/scripts/fetch-ripgrep.mjs <destRoot> [<platform>-<arch> ...]
//   (default targets: win32-x64 and this machine's platform)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RIPGREP_VERSION = "15.2.0";

// SHA-256 from each asset's `.sha256` file on the 15.2.0 release page, and checked against a hash
// of the downloaded file (2026-10-29).
export const RIPGREP_ASSETS = {
  "win32-x64": {
    file: "ripgrep-15.2.0-x86_64-pc-windows-msvc.zip",
    sha256: "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
  },
  "darwin-arm64": {
    file: "ripgrep-15.2.0-aarch64-apple-darwin.tar.gz",
    sha256: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
  },
  "darwin-x64": {
    file: "ripgrep-15.2.0-x86_64-apple-darwin.tar.gz",
    sha256: "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
  },
  "linux-x64": {
    file: "ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz",
    sha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
  },
};

const LICENSE_FILES = ["COPYING", "LICENSE-MIT", "UNLICENSE"];

/** The Irix target is Windows x64; this machine's platform is added for local smoke tests. */
export function packTargets(platform = process.platform, arch = process.arch) {
  const local = `${platform}-${arch}`;
  return local !== "win32-x64" && RIPGREP_ASSETS[local] ? ["win32-x64", local] : ["win32-x64"];
}

/** The commands that may unpack `archive` (a bare name in the current folder), best first. */
export function extractAttempts({ platform = process.platform, systemRoot, archive }) {
  const zip = archive.endsWith(".zip");
  const tarArgs = zip ? ["-xf", archive] : ["-xzf", archive];
  const attempts = [];
  if (platform === "win32") {
    const root = systemRoot || process.env.SystemRoot || "C:\\Windows";
    attempts.push([path.win32.join(root, "System32", "tar.exe"), tarArgs]);
  }
  attempts.push(["tar", tarArgs]);
  if (zip) attempts.push(["unzip", ["-q", "-o", archive]]);
  return attempts;
}

async function httpsDownload(url) {
  let response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (error) {
    const cause =
      error instanceof Error && error.cause ? ` (${error.cause.code ?? error.cause})` : "";
    throw new Error(`Could not download ${url}${cause}`, { cause: error });
  }
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function extract(directory, archive) {
  const failures = [];
  for (const [command, args] of extractAttempts({ archive })) {
    const result = spawnSync(command, args, { cwd: directory, encoding: "utf8" });
    if (!result.error && result.status === 0) return;
    failures.push(`${command}: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  }
  throw new Error(`Could not unpack ${archive}:\n  ${failures.join("\n  ")}`);
}

/**
 * Downloads, checks and unpacks ripgrep for each `<platform>-<arch>` in `targets`. Every archive
 * is checked before anything is written to `destRoot`, so a mismatch leaves it untouched.
 */
export async function fetchRipgrep(destRoot, targets = packTargets(), options = {}) {
  const assets = options.assets ?? RIPGREP_ASSETS;
  const version = options.version ?? RIPGREP_VERSION;
  const download = options.download ?? httpsDownload;
  const log = options.log ?? (() => {});

  for (const key of targets) {
    if (!assets[key]) {
      throw new Error(
        `No pinned ripgrep asset for ${key}; known: ${Object.keys(assets).join(", ")}`,
      );
    }
  }

  const work = mkdtempSync(path.join(tmpdir(), "irix-ripgrep-"));
  try {
    const checked = [];
    for (const key of targets) {
      const { file, sha256 } = assets[key];
      const url = `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${file}`;
      log(`ripgrep  downloading ${url}`);
      const buffer = await download(url);
      const actual = createHash("sha256").update(buffer).digest("hex");
      if (actual !== sha256) {
        throw new Error(`SHA-256 mismatch for ${file}: expected ${sha256}, got ${actual}`);
      }
      checked.push({ key, file, buffer });
    }

    for (const { key, file, buffer } of checked) {
      const directory = path.join(work, key);
      mkdirSync(directory);
      writeFileSync(path.join(directory, file), buffer);
      extract(directory, file);
      const stem = path.join(directory, file.replace(/\.(zip|tar\.gz)$/u, ""));
      const exe = key.startsWith("win32-") ? "rg.exe" : "rg";
      if (!existsSync(path.join(stem, exe))) throw new Error(`${file} has no ${exe} in it`);

      const target = path.join(destRoot, "vendor", key);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      copyFileSync(path.join(stem, exe), path.join(target, exe));
      if (exe === "rg") chmodSync(path.join(target, exe), 0o755);
      for (const name of LICENSE_FILES) {
        if (existsSync(path.join(stem, name))) {
          copyFileSync(path.join(stem, name), path.join(target, name));
        }
      }
      log(`ripgrep  ${key} -> ${path.join(target, exe)}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destRoot, ...targets] = process.argv.slice(2);
  if (!destRoot) {
    process.stderr.write("Usage: node irix/scripts/fetch-ripgrep.mjs <destRoot> [targets...]\n");
    process.exit(2);
  }
  fetchRipgrep(path.resolve(destRoot), targets.length > 0 ? targets : packTargets(), {
    log: (line) => process.stdout.write(`${line}\n`),
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
}
