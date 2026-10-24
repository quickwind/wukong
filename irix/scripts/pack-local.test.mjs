import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildStamp,
  buildVersion,
  coreVersion,
  makeZip,
  parseArgs,
  staleBundle,
  staleTarball,
  zipAttempts,
} from "./pack-local.mjs";

test("puts the output in ~/irix-dist unless --out says otherwise", () => {
  assert.equal(parseArgs([]).out, path.join(homedir(), "irix-dist"));
  assert.equal(parseArgs(["--scope", "acme"]).out, path.join(homedir(), "irix-dist"));
  assert.equal(parseArgs(["--out", "elsewhere"]).out, "elsewhere");
});

test("parses the options and defaults the scope to irix", () => {
  assert.deepEqual(parseArgs(["--out", "dist"]), {
    out: "dist",
    scope: "irix",
    workDir: "",
    keep: false,
  });
  assert.deepEqual(
    parseArgs(["--out", "d", "--scope", "@acme", "--work-dir", "C:\\wk", "--keep"]),
    {
      out: "d",
      scope: "acme",
      workDir: "C:\\wk",
      keep: true,
    },
  );
});

test("rejects a bad scope, the upstream scope and unknown options", () => {
  assert.throws(() => parseArgs(["--out", "d", "--scope", "Acme Corp"]), /lowercase npm scope/);
  assert.throws(() => parseArgs(["--out", "d", "--scope", "getpaseo"]), /upstream/);
  assert.throws(() => parseArgs(["--out", "d", "--nope"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--out"]), /needs a value/);
});

test("strips the prerelease and stamps the build in UTC", () => {
  assert.equal(coreVersion("0.11.2-beta.4"), "0.11.2");
  assert.equal(coreVersion("0.11.2"), "0.11.2");
  assert.equal(buildStamp(new Date(Date.UTC(2026, 9, 10, 3, 5))), "202610100305");
});

test("the build version carries the short commit, and .dirty when the tree had changes", () => {
  const parts = { core: "0.12.0", stamp: "202610220146", revision: "08fc0f11" };
  assert.equal(buildVersion({ ...parts, dirty: false }), "0.12.0-irix.202610220146.g08fc0f11");
  assert.equal(buildVersion({ ...parts, dirty: true }), "0.12.0-irix.202610220146.g08fc0f11.dirty");
});

test("a commit made only of digits still gives a valid semver version", () => {
  const version = buildVersion({
    core: "0.12.0",
    stamp: "202610220146",
    revision: "01234567",
    dirty: true,
  });
  const prerelease = version.split("-").slice(1).join("-").split(".");
  for (const identifier of prerelease) {
    assert.match(identifier, /^(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)$/u);
  }
});

test("only tarballs of the same scope count as leftovers from an earlier build", () => {
  assert.equal(staleTarball("irix-cli-0.11.2-irix.1.tgz", "irix"), true);
  assert.equal(staleTarball("acme-cli-1.0.0.tgz", "irix"), false);
  assert.equal(staleTarball("irix-ui-render-0.1.0-offline.tgz", "irix"), false);
  assert.equal(staleTarball("INSTALL-WINDOWS.md", "irix"), false);
});

test("only bundles of the same scope count as leftovers", () => {
  assert.equal(staleBundle("irix-0.11.2-irix.1.zip", "irix"), true);
  assert.equal(staleBundle("acme-1.0.0.zip", "irix"), false);
  assert.equal(staleBundle("paseo-bots-0.2.0-offline.2.zip", "irix"), false);
  assert.equal(staleBundle("irix-ui-render-0.1.0-offline.zip", "irix"), false);
  assert.equal(staleBundle("irix-export-session-0.1.0-offline.zip", "irix"), false);
  assert.equal(staleBundle("irix-cli-0.11.2-irix.1.tgz", "irix"), false);
});

// Lists a zip with whichever tool the machine has. bsdtar reads zip; GNU tar does not, and on
// Windows `tar` may be GNU tar from Git Bash, so the system's tar.exe is tried first and the zip is
// named relative to its folder (GNU tar reads `C:\\...` as host:file).
function zipEntries(zipFile) {
  const systemTar =
    process.platform === "win32"
      ? path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  const options = { encoding: "utf8", cwd: path.dirname(zipFile) };
  const name = path.basename(zipFile);
  for (const [command, args] of [
    [systemTar, ["-tf", name]],
    ["tar", ["-tf", name]],
    ["unzip", ["-Z1", name]],
  ]) {
    const result = spawnSync(command, args, options);
    if (!result.error && result.status === 0) {
      return result.stdout.split(/\r?\n/u).filter(Boolean);
    }
  }
  throw new Error("no tool to list a zip");
}

test("zip attempts: Windows tries its own tar first and PowerShell last, others never PowerShell", () => {
  const input = { zipFile: "C:\\out\\a.zip", members: ["a.tgz", "it's.md"] };
  const win = zipAttempts({ ...input, platform: "win32", systemRoot: "C:\\Windows" });
  assert.equal(win[0][0], "C:\\Windows\\System32\\tar.exe");
  assert.deepEqual(win.map(([command]) => command).slice(1), ["tar", "zip", "powershell"]);
  const script = win.at(-1)[1].at(-1);
  assert.match(
    script,
    /Compress-Archive -LiteralPath 'a\.tgz','it''s\.md' -DestinationPath 'C:\\out\\a\.zip' -Force/,
  );
  assert.deepEqual(
    zipAttempts({ ...input, platform: "darwin" }).map(([command]) => command),
    ["tar", "zip"],
  );
});

test("makeZip puts the given files at the top of one zip, and replaces an old one", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "irix-zip-"));
  try {
    for (const name of ["a.tgz", "b.tgz", "windows-update.ps1", "INSTALL-WINDOWS.md"]) {
      writeFileSync(path.join(directory, name), name);
    }
    const zipFile = path.join(tmpdir(), `irix-zip-test-${process.pid}.zip`);
    writeFileSync(zipFile, "stale");
    makeZip(zipFile, directory, ["a.tgz", "b.tgz", "windows-update.ps1", "INSTALL-WINDOWS.md"]);
    assert.deepEqual(zipEntries(zipFile).sort(), [
      "INSTALL-WINDOWS.md",
      "a.tgz",
      "b.tgz",
      "windows-update.ps1",
    ]);
    rmSync(zipFile);
    assert.equal(existsSync(zipFile), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("makeZip fails clearly when a member is missing", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "irix-zip-"));
  try {
    const zipFile = path.join(directory, "out.zip");
    assert.throws(() => makeZip(zipFile, directory, ["nope.tgz"]), /Could not write the zip/);
    assert.equal(existsSync(zipFile), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
