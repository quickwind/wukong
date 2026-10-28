import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractAttempts,
  fetchRipgrep,
  packTargets,
  RIPGREP_ASSETS,
  RIPGREP_VERSION,
} from "./fetch-ripgrep.mjs";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function has(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return !result.error;
}

/** Builds a release-shaped archive (`<stem>/rg`, `<stem>/LICENSE-MIT`, ...) with a system tool. */
function buildArchive({ kind, stem, exe }) {
  const work = mkdtempSync(path.join(tmpdir(), "irix-rg-archive-"));
  mkdirSync(path.join(work, stem));
  writeFileSync(path.join(work, stem, exe), "#!/bin/sh\necho fake rg\n", { mode: 0o755 });
  for (const name of ["COPYING", "LICENSE-MIT", "UNLICENSE"]) {
    writeFileSync(path.join(work, stem, name), `${name} text\n`);
  }
  const file = path.join(work, kind === "zip" ? "a.zip" : "a.tar.gz");
  const args =
    kind === "zip" ? ["-q", "-r", path.basename(file), stem] : ["-czf", path.basename(file), stem];
  const result = spawnSync(kind === "zip" ? "zip" : "tar", args, { cwd: work });
  assert.equal(result.status, 0, String(result.stderr));
  const buffer = readFileSync(file);
  rmSync(work, { recursive: true, force: true });
  return buffer;
}

function tempDest() {
  const dest = mkdtempSync(path.join(tmpdir(), "irix-rg-dest-"));
  return { dest, cleanup: () => rmSync(dest, { recursive: true, force: true }) };
}

test("pins one version and a SHA-256 for each supported platform", () => {
  assert.match(RIPGREP_VERSION, /^\d+\.\d+\.\d+$/u);
  for (const key of ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"]) {
    const asset = RIPGREP_ASSETS[key];
    assert.ok(asset, key);
    assert.ok(asset.file.startsWith(`ripgrep-${RIPGREP_VERSION}-`), asset.file);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
  }
  assert.ok(RIPGREP_ASSETS["win32-x64"].file.endsWith("-x86_64-pc-windows-msvc.zip"));
});

test("packs Windows x64 always, and this machine's platform when it differs", () => {
  assert.deepEqual(packTargets("win32", "x64"), ["win32-x64"]);
  assert.deepEqual(packTargets("darwin", "arm64"), ["win32-x64", "darwin-arm64"]);
  assert.deepEqual(packTargets("linux", "x64"), ["win32-x64", "linux-x64"]);
  // No pinned asset for this machine: only the Windows one.
  assert.deepEqual(packTargets("freebsd", "x64"), ["win32-x64"]);
});

test("an unknown platform key throws a clear message", async () => {
  const { dest, cleanup } = tempDest();
  try {
    await assert.rejects(
      fetchRipgrep(dest, ["plan9-mips"], { download: async () => Buffer.alloc(0) }),
      /No pinned ripgrep asset for plan9-mips/,
    );
  } finally {
    cleanup();
  }
});

test("a checksum mismatch throws and leaves nothing in destRoot", async () => {
  const { dest, cleanup } = tempDest();
  try {
    const assets = { "linux-x64": { file: "ripgrep-1.0.0-x.tar.gz", sha256: "0".repeat(64) } };
    await assert.rejects(
      fetchRipgrep(dest, ["linux-x64"], {
        assets,
        version: "1.0.0",
        download: async () => Buffer.from("tampered"),
      }),
      /SHA-256 mismatch for ripgrep-1\.0\.0-x\.tar\.gz/,
    );
    assert.deepEqual(readdirSync(dest), []);
  } finally {
    cleanup();
  }
});

test("extracts a tar.gz release to vendor/<platform>-<arch>/rg with its licenses", async (t) => {
  if (!has("tar")) {
    t.skip("tar is not installed");
    return;
  }
  const stem = "ripgrep-1.0.0-x86_64-unknown-linux-musl";
  const buffer = buildArchive({ kind: "tar", stem, exe: "rg" });
  const assets = { "linux-x64": { file: `${stem}.tar.gz`, sha256: sha256(buffer) } };
  const { dest, cleanup } = tempDest();
  try {
    const urls = [];
    await fetchRipgrep(dest, ["linux-x64"], {
      assets,
      version: "1.0.0",
      download: async (url) => {
        urls.push(url);
        return buffer;
      },
    });
    assert.deepEqual(urls, [
      `https://github.com/BurntSushi/ripgrep/releases/download/1.0.0/${stem}.tar.gz`,
    ]);
    const binary = path.join(dest, "vendor", "linux-x64", "rg");
    assert.match(readFileSync(binary, "utf8"), /fake rg/);
    // Windows has no executable bit.
    if (process.platform !== "win32") assert.ok(statSync(binary).mode & 0o100, "rg is executable");
    for (const name of ["COPYING", "LICENSE-MIT", "UNLICENSE"]) {
      assert.ok(existsSync(path.join(dest, "vendor", "linux-x64", name)), name);
    }
    assert.deepEqual(readdirSync(dest), ["vendor"]);
    assert.deepEqual(readdirSync(path.join(dest, "vendor")), ["linux-x64"]);
  } finally {
    cleanup();
  }
});

test("extracts a Windows zip release to vendor/win32-x64/rg.exe", async (t) => {
  if (!has("zip")) {
    t.skip("zip is not installed, so no test zip can be built");
    return;
  }
  const stem = "ripgrep-1.0.0-x86_64-pc-windows-msvc";
  const buffer = buildArchive({ kind: "zip", stem, exe: "rg.exe" });
  const assets = { "win32-x64": { file: `${stem}.zip`, sha256: sha256(buffer) } };
  const { dest, cleanup } = tempDest();
  try {
    await fetchRipgrep(dest, ["win32-x64"], {
      assets,
      version: "1.0.0",
      download: async () => buffer,
    });
    const binary = path.join(dest, "vendor", "win32-x64", "rg.exe");
    assert.match(readFileSync(binary, "utf8"), /fake rg/);
    assert.ok(existsSync(path.join(dest, "vendor", "win32-x64", "LICENSE-MIT")));
  } finally {
    cleanup();
  }
});

test("replaces an earlier vendor folder for the same platform", async (t) => {
  if (!has("tar")) {
    t.skip("tar is not installed");
    return;
  }
  const stem = "ripgrep-1.0.0-x86_64-unknown-linux-musl";
  const buffer = buildArchive({ kind: "tar", stem, exe: "rg" });
  const assets = { "linux-x64": { file: `${stem}.tar.gz`, sha256: sha256(buffer) } };
  const { dest, cleanup } = tempDest();
  try {
    mkdirSync(path.join(dest, "vendor", "linux-x64"), { recursive: true });
    writeFileSync(path.join(dest, "vendor", "linux-x64", "stale"), "");
    await fetchRipgrep(dest, ["linux-x64"], {
      assets,
      version: "1.0.0",
      download: async () => buffer,
    });
    assert.equal(existsSync(path.join(dest, "vendor", "linux-x64", "stale")), false);
  } finally {
    cleanup();
  }
});

test("reads a zip with bsdtar first on Windows, and falls back to unzip elsewhere", () => {
  const windows = extractAttempts({
    platform: "win32",
    systemRoot: "C:\\Windows",
    archive: "a.zip",
  });
  assert.deepEqual(windows[0], ["C:\\Windows\\System32\\tar.exe", ["-xf", "a.zip"]]);
  const linux = extractAttempts({ platform: "linux", archive: "a.zip" });
  assert.deepEqual(linux.at(-1), ["unzip", ["-q", "-o", "a.zip"]]);
  assert.deepEqual(extractAttempts({ platform: "linux", archive: "a.tar.gz" }), [
    ["tar", ["-xzf", "a.tar.gz"]],
  ]);
});
