// How much of upstream does Irix change? Lists every upstream file this branch modifies, with the
// lines added and removed, and fails when the footprint breaks the rules in IRIX.md:
//   - an upstream file was deleted or renamed
//   - a modified upstream file has no `Irix` marker in the lines it added
//   - the totals go over the budget
// Files Irix adds (irix/, plugins/irix-*, packages/*/src/irix/, workflows) are not counted:
// they cannot conflict with upstream.
//
//   node irix/scripts/upstream-footprint.mjs [--base <ref>] [--max-files 40] [--max-lines 400]
//
// The base defaults to the merge base with upstream/main (run `git fetch upstream` first).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = /Irix|IRIX/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function resolveBase(cwd, base) {
  if (base) return base;
  try {
    return git(cwd, "merge-base", "HEAD", "upstream/main").trim();
  } catch {
    throw new Error(
      "No upstream/main to compare with. Run `git fetch upstream`, or pass --base <ref>.",
    );
  }
}

export function footprint({ cwd = process.cwd(), base, to, maxFiles = 40, maxLines = 400 } = {}) {
  const from = resolveBase(cwd, base);
  const diffTarget = to ? [from, to] : [from];
  const status = git(cwd, "diff", "--name-status", "-M", ...diffTarget)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const modified = [];
  const problems = [];
  for (const [code, ...paths] of status) {
    if (code === "A") continue;
    if (code !== "M") {
      problems.push(
        `${paths.join(" -> ")}: an upstream file was ${code.startsWith("R") ? "renamed" : "deleted"}`,
      );
      continue;
    }
    const file = paths[0];
    const patch = git(cwd, "diff", "-U0", ...diffTarget, "--", file).split("\n");
    const added = patch.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    const removed = patch.filter((line) => line.startsWith("-") && !line.startsWith("---"));
    modified.push({ file, added: added.length, removed: removed.length });
    if (!added.some((line) => MARKER.test(line))) {
      problems.push(
        `${file}: no "Irix" marker in the lines added (say why the upstream file is touched)`,
      );
    }
  }
  modified.sort((a, b) => b.added + b.removed - (a.added + a.removed));
  const lines = modified.reduce((sum, entry) => sum + entry.added + entry.removed, 0);
  if (modified.length > maxFiles)
    problems.push(`${modified.length} upstream files modified; the budget is ${maxFiles}`);
  if (lines > maxLines) problems.push(`${lines} upstream lines changed; the budget is ${maxLines}`);
  return { base: from, modified, lines, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > -1 ? process.argv[index + 1] : undefined;
  };
  const report = footprint({
    base: arg("base"),
    to: arg("to"),
    maxFiles: Number(arg("max-files") ?? 40),
    maxLines: Number(arg("max-lines") ?? 400),
  });
  console.log(
    `base ${report.base.slice(0, 9)}: ${report.modified.length} upstream files modified, ${report.lines} lines`,
  );
  for (const { file, added, removed } of report.modified) {
    console.log(`  +${String(added).padEnd(3)} -${String(removed).padEnd(3)} ${file}`);
  }
  for (const problem of report.problems) console.error(`PROBLEM: ${problem}`);
  process.exit(report.problems.length > 0 ? 1 : 0);
}
