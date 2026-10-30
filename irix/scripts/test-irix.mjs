#!/usr/bin/env node
// One command for every Irix test, in a clean environment.
//
//   node irix/scripts/test-irix.mjs [--base <ref>] [--only <step>] [--browser] [--dry-run]
//
// Steps run in order and a failure does not stop the later ones; a table at the end shows
// each step's status and time, and the exit code is 1 if any step failed. Every child runs
// with the PASEO_* and IRIX_* variables removed so a result never depends on the caller's
// shell. `--browser` (or IRIX_TEST_BROWSER=1) adds the Playwright suite in irix/e2e.
// `--dry-run` prints the commands and the variable names that would be removed, then exits 0.
// The server step includes the *.e2e.test.ts files (the daemon's `test:unit` excludes them)
// and takes a few minutes. See irix/docs/test-plan.md.

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRUBBED_PREFIXES = ["PASEO_", "IRIX_"];
const SEAM_FILE = "packages/server/src/irix/seams.test.ts";
const BROWSER_CONFIG = "irix/e2e/playwright.config.ts";

export function stepNames() {
  return buildSteps({}).map((step) => step.name);
}

export function parseArgs(argv, env = {}) {
  const options = {
    base: undefined,
    only: undefined,
    browser: env.IRIX_TEST_BROWSER === "1",
    dryRun: false,
    error: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--browser") options.browser = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--base" || arg === "--only") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        options.error = `${arg} needs a value`;
        break;
      }
      options[arg.slice(2)] = value;
      i += 1;
    } else {
      options.error = `unknown argument: ${arg}`;
      break;
    }
  }
  if (!options.error && options.only && !stepNames().includes(options.only)) {
    options.error = `unknown step "${options.only}" (steps: ${stepNames().join(", ")})`;
  }
  return options;
}

export function scrubEnv(env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SCRUBBED_PREFIXES.some((prefix) => key.startsWith(prefix))) clean[key] = value;
  }
  return clean;
}

export function scrubbedKeys(env) {
  return Object.keys(env)
    .filter((key) => SCRUBBED_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .sort();
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * The last upstream state this checkout merged. A sync merges either `upstream/main` or a release
 * tag, and a tag is not always an ancestor of `main`, so neither alone is right: take whichever
 * is nearer to HEAD. Returns undefined when git cannot say (then the footprint script's own default
 * applies).
 */
export function lastMergedUpstreamBase(run = git) {
  const candidates = [];
  try {
    candidates.push(run("merge-base", "HEAD", "upstream/main"));
  } catch {
    // no upstream remote
  }
  try {
    candidates.push(run("describe", "--tags", "--match", "v[0-9]*", "--abbrev=0", "HEAD"));
  } catch {
    // no release tag reachable
  }
  let best;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ref of candidates) {
    try {
      const distance = Number(run("rev-list", "--count", `${ref}..HEAD`));
      if (distance < bestDistance) {
        best = ref;
        bestDistance = distance;
      }
    } catch {
      // ignore an unusable ref
    }
  }
  return best;
}

export function buildSteps({ base } = {}) {
  return [
    {
      name: "footprint",
      cwd: ".",
      command: "node",
      args: ["irix/scripts/upstream-footprint.mjs", ...(base ? ["--base", base] : [])],
    },
    { name: "license", cwd: ".", command: "node", args: ["irix/scripts/license-audit.mjs"] },
    { name: "scripts", cwd: ".", command: "node", args: ["--test", "irix/scripts/*.test.mjs"] },
    {
      name: "server",
      cwd: "packages/server",
      command: "npx",
      args: ["vitest", "run", "src/irix", "--maxWorkers=1"],
    },
    {
      name: "cli",
      cwd: "packages/cli",
      command: "npx",
      args: ["vitest", "run", "src/irix"],
    },
    {
      name: "app",
      cwd: "packages/app",
      command: "npx",
      args: ["vitest", "run", "src/irix", "src/usage"],
    },
    {
      name: "plugins",
      cwd: "plugins",
      command: "npx",
      args: [
        "vitest",
        "run",
        "irix-gitlab",
        "irix-devin-usage",
        "irix-claude-usage",
        "irix-context-hint",
        "irix-content-search",
      ],
    },
    {
      name: "browser",
      cwd: ".",
      command: "npx",
      args: ["playwright", "test", "-c", BROWSER_CONFIG],
      optional: true,
    },
  ];
}

export function selectSteps(options) {
  return buildSteps(options).filter((step) => {
    if (options.only) return step.name === options.only;
    return !step.optional || options.browser;
  });
}

// vitest prints `FAIL  src/irix/seams.test.ts > suite > test name` for each failed test.
export function extractSeamFailures(output) {
  const names = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/FAIL\s+(?:\S*\/)?src\/irix\/seams\.test\.ts\s+>\s+(.+?)\s*$/);
    if (match) names.add(match[1]);
  }
  return [...names];
}

export function seamHint(seamFailures) {
  if (seamFailures.length === 0) return "";
  return [
    "",
    "!!! SEAM TESTS FAILED !!!",
    `Upstream changed something an Irix hook depends on (${SEAM_FILE}).`,
    "The failing test names are the list of hooks to review, before anything else:",
    ...seamFailures.map((name) => `  - ${name}`),
    "Fix the hook (smallest marked change), then re-run: node irix/scripts/test-irix.mjs --only server",
    "",
  ].join("\n");
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function renderTable(results) {
  const rows = results.map((r) => [
    r.name,
    r.status + (r.note ? ` (${r.note})` : ""),
    formatDuration(r.durationMs ?? 0),
  ]);
  const header = ["step", "status", "duration"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function exitCodeFor(results) {
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

function runStep(step, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    const child = spawn(step.command, step.args, {
      cwd: path.join(REPO_ROOT, step.cwd),
      env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const forward = (stream, sink) =>
      stream.on("data", (chunk) => {
        sink.write(chunk);
        output = (output + chunk.toString()).slice(-2_000_000);
      });
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    let spawnError;
    child.on("error", (error) => {
      spawnError = error;
    });
    // "close" follows "error" for a failed spawn, so the promise settles in one place.
    child.on("close", (code) => {
      const failed = spawnError !== undefined || code !== 0;
      let note;
      if (spawnError) note = spawnError.message;
      else if (failed) note = `exit ${code}`;
      resolve({
        name: step.name,
        status: failed ? "FAIL" : "pass",
        note,
        durationMs: Date.now() - started,
        output,
      });
    });
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv, env);
  if (options.error) {
    console.error(`test-irix: ${options.error}`);
    return 2;
  }
  if (!options.base) options.base = lastMergedUpstreamBase();
  const steps = selectSteps(options);
  const cleanEnv = scrubEnv(env);

  if (options.dryRun) {
    console.log(`removed from the environment: ${scrubbedKeys(env).join(", ") || "(none set)"}`);
    console.log(`removed prefixes: ${SCRUBBED_PREFIXES.join(", ")}`);
    for (const step of steps) {
      console.log(`[${step.name}] (cd ${step.cwd} && ${[step.command, ...step.args].join(" ")})`);
    }
    return 0;
  }

  const results = [];
  for (const step of steps) {
    console.log(
      `\n=== ${step.name}: ${[step.command, ...step.args].join(" ")} (in ${step.cwd}) ===`,
    );
    if (step.name === "browser" && !existsSync(path.join(REPO_ROOT, BROWSER_CONFIG))) {
      console.log(`skipped: ${BROWSER_CONFIG} does not exist yet`);
      results.push({
        name: step.name,
        status: "skipped",
        note: "no irix/e2e config",
        durationMs: 0,
      });
      continue;
    }
    results.push(await runStep(step, cleanEnv));
  }

  const seamFailures = extractSeamFailures(results.find((r) => r.name === "server")?.output ?? "");
  const hint = seamHint(seamFailures);
  if (hint) console.log(hint);
  console.log(`\n${renderTable(results)}`);
  return exitCodeFor(results);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
