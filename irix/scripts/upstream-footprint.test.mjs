import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { footprint } from "./upstream-footprint.mjs";

function repo(setup) {
  const dir = mkdtempSync(path.join(tmpdir(), "irix-footprint-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  write("a.ts", "one\ntwo\nthree\n");
  write("b.ts", "one\ntwo\nthree\n");
  write("c.ts", "keep\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  setup({ git, write, dir });
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  return { dir, base, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("counts modified upstream files and ignores files Irix adds", () => {
  const { dir, base, cleanup } = repo(({ write }) => {
    write("a.ts", "one\nTWO // Irix: why\nthree\n");
    write("irix/new.ts", "lots\nof\nnew\ncode\n");
  });
  try {
    const report = footprint({ cwd: dir, base });
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.modified, [{ file: "a.ts", added: 1, removed: 1 }]);
    assert.equal(report.lines, 2);
  } finally {
    cleanup();
  }
});

test("flags a modified upstream file with no Irix marker", () => {
  const { dir, base, cleanup } = repo(({ write }) => write("b.ts", "one\nchanged\nthree\n"));
  try {
    const { problems } = footprint({ cwd: dir, base });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /b\.ts: no "Irix" marker/);
  } finally {
    cleanup();
  }
});

test("flags a deleted or renamed upstream file", () => {
  const { dir, base, cleanup } = repo(({ git }) => {
    git("rm", "-q", "c.ts");
    git("mv", "b.ts", "b2.ts");
  });
  try {
    const { problems } = footprint({ cwd: dir, base });
    assert.ok(
      problems.some((p) => /c\.ts: an upstream file was deleted/.test(p)),
      problems.join("\n"),
    );
    assert.ok(
      problems.some((p) => /renamed/.test(p)),
      problems.join("\n"),
    );
  } finally {
    cleanup();
  }
});

test("fails when the totals pass the budget", () => {
  const { dir, base, cleanup } = repo(({ write }) => {
    write("a.ts", "// Irix\nx\ny\nz\n");
    write("b.ts", "// Irix\nx\ny\nz\n");
  });
  try {
    assert.equal(footprint({ cwd: dir, base, maxFiles: 5, maxLines: 100 }).problems.length, 0);
    const files = footprint({ cwd: dir, base, maxFiles: 1 }).problems;
    assert.match(files[0], /2 upstream files modified; the budget is 1/);
    const lines = footprint({ cwd: dir, base, maxLines: 3 }).problems;
    assert.match(lines[0], /upstream lines changed; the budget is 3/);
  } finally {
    cleanup();
  }
});
