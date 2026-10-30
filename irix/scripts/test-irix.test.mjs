import assert from "node:assert/strict";
import test from "node:test";

import {
  lastMergedUpstreamBase,
  buildSteps,
  exitCodeFor,
  extractSeamFailures,
  main,
  parseArgs,
  renderTable,
  scrubEnv,
  seamHint,
  selectSteps,
} from "./test-irix.mjs";

test("parseArgs reads --base, --only, --browser and the env switch", () => {
  assert.deepEqual(
    { ...parseArgs(["--base", "v0.14.0", "--only", "app", "--dry-run"]) },
    { base: "v0.14.0", only: "app", browser: false, dryRun: true, error: undefined },
  );
  assert.equal(parseArgs(["--browser"]).browser, true);
  assert.equal(parseArgs([], { IRIX_TEST_BROWSER: "1" }).browser, true);
  assert.equal(parseArgs([], { IRIX_TEST_BROWSER: "0" }).browser, false);
});

test("parseArgs rejects bad input", () => {
  assert.match(parseArgs(["--nope"]).error, /unknown argument/);
  assert.match(parseArgs(["--only"]).error, /needs a value/);
  assert.match(parseArgs(["--only", "nothing"]).error, /unknown step/);
});

test("scrubEnv removes every PASEO_* and IRIX_* variable and keeps the rest", () => {
  const clean = scrubEnv({
    PATH: "/bin",
    HOME: "/home/x",
    PASEO_HOME: "/p",
    PASEO_AGENT_ID: "a",
    IRIX_PORT: "1",
    IRIX_TEST_BROWSER: "1",
    NOT_IRIX_THING: "kept",
  });
  assert.deepEqual(clean, { PATH: "/bin", HOME: "/home/x", NOT_IRIX_THING: "kept" });
});

test("steps run in the documented order, browser only when asked", () => {
  assert.deepEqual(
    selectSteps({}).map((s) => s.name),
    ["footprint", "license", "scripts", "server", "cli", "app", "plugins"],
  );
  assert.equal(selectSteps({ browser: true }).at(-1).name, "browser");
  assert.deepEqual(
    selectSteps({ only: "browser" }).map((s) => s.name),
    ["browser"],
  );
});

test("--base is passed to the footprint step only when given", () => {
  assert.deepEqual(buildSteps({}).at(0).args, ["irix/scripts/upstream-footprint.mjs"]);
  assert.deepEqual(buildSteps({ base: "v0.14.0" }).at(0).args.slice(-2), ["--base", "v0.14.0"]);
});

test("the server step runs src/irix serially, which includes the e2e files", () => {
  const server = buildSteps({}).find((s) => s.name === "server");
  assert.deepEqual(server.args, ["vitest", "run", "src/irix", "--maxWorkers=1"]);
});

test("table lists each step; exit code is 1 only when a step failed", () => {
  const results = [
    { name: "footprint", status: "pass", durationMs: 400 },
    { name: "server", status: "FAIL", note: "exit 1", durationMs: 125_000 },
    { name: "browser", status: "skipped", durationMs: 0 },
  ];
  const table = renderTable(results);
  assert.match(table, /footprint\s+pass\s+400ms/);
  assert.match(table, /server\s+FAIL \(exit 1\)\s+2m05s/);
  assert.match(table, /browser\s+skipped/);
  assert.equal(exitCodeFor(results), 1);
  assert.equal(exitCodeFor(results.filter((r) => r.status !== "FAIL")), 0);
});

test("seam failures are picked out of vitest output", () => {
  const output = [
    " FAIL  src/irix/seams.test.ts > config store > patch returns a promise",
    " FAIL  src/irix/seams.test.ts > config store > patch returns a promise",
    " FAIL  src/irix/other.test.ts > not a seam",
    " FAIL  src/irix/seams.test.ts > claude > createSession argument positions",
  ].join("\n");
  const names = extractSeamFailures(output);
  assert.deepEqual(names, [
    "config store > patch returns a promise",
    "claude > createSession argument positions",
  ]);
  assert.match(seamHint(names), /SEAM TESTS FAILED/);
  assert.match(seamHint(names), /patch returns a promise/);
  assert.equal(seamHint([]), "");
});

test("--dry-run prints commands without running them and exits 0", async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const code = await main(["--dry-run", "--only", "scripts"], { PATH: "/bin", PASEO_HOME: "/x" });
    assert.equal(code, 0);
  } finally {
    console.log = original;
  }
  assert.match(lines.join("\n"), /removed from the environment: PASEO_HOME/);
  assert.match(lines.join("\n"), /\[scripts\].*node --test/);
});

test("main returns 2 on a usage error", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await main(["--wat"], {}), 2);
  } finally {
    console.error = original;
  }
});

test("the footprint base is whichever of merge-base and release tag is nearer to HEAD", () => {
  const distance = { mb111: 40, v1: 3 };
  const run = (...args) => {
    if (args[0] === "merge-base") return "mb111";
    if (args[0] === "describe") return "v1";
    if (args[0] === "rev-list") return String(distance[args[2].split("..")[0]]);
    throw new Error("unexpected");
  };
  assert.equal(lastMergedUpstreamBase(run), "v1");
  assert.equal(
    lastMergedUpstreamBase((...args) => {
      if (args[0] === "describe") throw new Error("no tag");
      return run(...args);
    }),
    "mb111",
  );
  assert.equal(
    lastMergedUpstreamBase(() => {
      throw new Error("no git");
    }),
    undefined,
  );
});
