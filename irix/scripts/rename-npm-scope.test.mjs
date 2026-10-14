import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));

test("rewrites the scope across the whole repository, not just the script's directory", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "irix-scope-"));
  mkdirSync(path.join(repo, "irix/scripts"), { recursive: true });
  mkdirSync(path.join(repo, "packages/server"), { recursive: true });
  cpSync(
    path.join(scripts, "rename-npm-scope.mjs"),
    path.join(repo, "irix/scripts/rename-npm-scope.mjs"),
  );
  writeFileSync(
    path.join(repo, "packages/server/package.json"),
    JSON.stringify({ name: "@getpaseo/server", dependencies: { "@getpaseo/client": "1.0.0" } }),
  );
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });

  execFileSync("node", ["irix/scripts/rename-npm-scope.mjs", "--scope", "acme"], { cwd: repo });

  const manifest = readFileSync(path.join(repo, "packages/server/package.json"), "utf8");
  assert.match(manifest, /"@acme\/server"/);
  assert.match(manifest, /"@acme\/client"/);
  assert.doesNotMatch(manifest, /@getpaseo\//);
});

test("refuses the upstream scope", () => {
  assert.throws(
    () =>
      execFileSync("node", [path.join(scripts, "rename-npm-scope.mjs"), "--scope", "getpaseo"], {
        stdio: "pipe",
      }),
    /Refusing to publish under the upstream/,
  );
});
