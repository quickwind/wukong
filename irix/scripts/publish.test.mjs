import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "publish.mjs");
const PACKAGES = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];

function makeTarball(directory, name) {
  const staging = mkdtempSync(path.join(tmpdir(), "irix-pkg-"));
  mkdirSync(path.join(staging, "package"));
  writeFileSync(
    path.join(staging, "package/package.json"),
    JSON.stringify({ name: `@acme/${name}`, version: "1.0.0-irix.1" }),
  );
  // Relative paths from inside the folder: GNU tar (Git Bash on Windows) reads `C:\\...` as host:file.
  const relativeStaging = path.relative(directory, staging).split(path.sep).join("/");
  execFileSync("tar", ["-czf", `acme-${name}-1.0.0-irix.1.tgz`, "-C", relativeStaging, "package"], {
    cwd: directory,
  });
}

test("publishes every package in dependency order, naming tarballs by absolute path", () => {
  const work = mkdtempSync(path.join(tmpdir(), "irix-publish-"));
  const tarballs = path.join(work, "dist-npm");
  mkdirSync(tarballs);
  for (const name of PACKAGES) makeTarball(tarballs, name);

  // A stand-in npm: `view` says nothing is published, `publish` records its arguments.
  const bin = path.join(work, "bin");
  mkdirSync(bin);
  const log = path.join(work, "calls.log");
  // On Windows the script has to be a batch file named npm.cmd, which is what the real npm is.
  if (process.platform === "win32") {
    writeFileSync(
      path.join(bin, "npm.cmd"),
      `@echo off\r\nif "%1"=="view" exit /b 1\r\necho %* >> "${log}"\r\n`,
    );
  } else {
    const fakeNpm = path.join(bin, "npm");
    writeFileSync(
      fakeNpm,
      `#!/bin/sh\nif [ "$1" = "view" ]; then exit 1; fi\necho "$@" >> "${log}"\n`,
    );
    chmodSync(fakeNpm, 0o755);
  }

  // Relative --dir, as the workflow passes it.
  execFileSync("node", [script, "--dir", "dist-npm", "--scope", "acme", "--dry-run"], {
    cwd: work,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });

  const calls = readFileSync(log, "utf8").trim().split(/\r?\n/u);
  assert.equal(calls.length, PACKAGES.length);
  calls.forEach((call, index) => {
    const tarball = call.split(" ")[1];
    assert.ok(path.isAbsolute(tarball), `${tarball} must be absolute`);
    assert.ok(tarball.includes(`acme-${PACKAGES[index]}-`), `${tarball} out of order`);
    assert.match(call, /--dry-run/);
  });
});

test("refuses the upstream scope", () => {
  assert.throws(
    () =>
      execFileSync("node", [script, "--dir", tmpdir(), "--scope", "getpaseo"], { stdio: "pipe" }),
    /Refusing to publish under the upstream scope/,
  );
});
