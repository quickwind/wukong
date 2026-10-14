import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyBuildFixes, FIXES } from "./build-fixes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function copyTarget() {
  const root = mkdtempSync(path.join(tmpdir(), "irix-fixes-"));
  for (const { file } of FIXES) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(path.join(repoRoot, file), path.join(root, file));
  }
  return root;
}

test("every fix still matches upstream (this fails after a sync that changes a target)", () => {
  applyBuildFixes({ root: repoRoot, dryRun: true });
});

test("lets the web UI build start npm through a shell on Windows only", () => {
  const root = copyTarget();
  const file = path.join(root, "scripts/build-daemon-web-ui.mjs");
  assert.match(readFileSync(file, "utf8"), /shell: false,/);
  applyBuildFixes({ root });
  const fixed = readFileSync(file, "utf8");
  assert.match(fixed, /shell: process\.platform === "win32",/);
  assert.doesNotMatch(fixed, /shell: false,/);
});

test("is idempotent, and leaves a script that upstream already fixed alone", () => {
  const root = copyTarget();
  applyBuildFixes({ root });
  const once = readFileSync(path.join(root, "scripts/build-daemon-web-ui.mjs"), "utf8");
  applyBuildFixes({ root });
  assert.equal(readFileSync(path.join(root, "scripts/build-daemon-web-ui.mjs"), "utf8"), once);

  const other = copyTarget();
  const file = path.join(other, "scripts/build-daemon-web-ui.mjs");
  writeFileSync(file, 'spawn(c, a, { shell: process.platform === "win32" });\n');
  applyBuildFixes({ root: other });
  assert.equal(
    readFileSync(file, "utf8"),
    'spawn(c, a, { shell: process.platform === "win32" });\n',
  );
});

test("fails loudly when upstream rewrites the line", () => {
  const root = copyTarget();
  writeFileSync(path.join(root, "scripts/build-daemon-web-ui.mjs"), "// rewritten\n");
  assert.throws(
    () => applyBuildFixes({ root }),
    /found nothing to change in scripts\/build-daemon-web-ui\.mjs/,
  );
});
