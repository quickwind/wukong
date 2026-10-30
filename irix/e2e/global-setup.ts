import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { OUTPUT_DIR, REPO_ROOT, STATE_FILE, type DaemonState } from "./support/env";

const WEB_UI_STAMP = path.join(OUTPUT_DIR, "web-ui-stamp");
const NEVER_PORTS = new Set([6767, 6890]);

// Sources the Irix web UI is built from. Anything newer than the stamp means a rebuild.
const WEB_UI_SOURCES = [
  "packages/app/src",
  "packages/app/package.json",
  "packages/app/app.config.js",
  "packages/app/metro.config.js",
  "packages/protocol/src",
  "packages/client/src",
  "packages/highlight/src",
];

// Sources that feed packages/server/dist and packages/cli/dist (the daemon and the `irix` bin).
const SERVER_SOURCES = [
  "packages/server/src",
  "packages/protocol/src",
  "packages/client/src",
  "packages/relay/src",
  "packages/highlight/src",
  "packages/plugin/src",
  "packages/cli/src",
  "plugins",
];
// Built outputs whose mtime says how fresh dist is. The oldest one counts.
const SERVER_DIST_MARKERS = [
  "packages/server/dist/scripts/supervisor-entrypoint.js",
  "packages/server/dist/server/server/bootstrap.js",
  "packages/cli/dist/index.js",
  "packages/cli/dist/irix/defaults.js",
];

const SKIP_FILE = /(\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|\.d\.ts|\.map|\.md)$/u;
const SKIP_DIR = new Set([
  "node_modules",
  "dist",
  ".git",
  "vendor",
  ".expo",
  "__snapshots__",
  "generated",
]);

/** Newest mtime (ms) of any relevant file under `target`; 0 when it does not exist. */
function newestMtime(target: string): number {
  const full = path.join(REPO_ROOT, target);
  if (!existsSync(full)) return 0;
  const stat = statSync(full);
  if (stat.isFile()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      newest = Math.max(newest, newestMtime(path.join(target, entry.name)));
    } else if (!SKIP_FILE.test(entry.name)) {
      newest = Math.max(newest, statSync(path.join(full, entry.name)).mtimeMs);
    }
  }
  return newest;
}

function runNpm(args: string[], env: NodeJS.ProcessEnv): void {
  console.log(`[irix-e2e] npm ${args.join(" ")}`);
  const result = spawnSync("npm", args, { cwd: REPO_ROOT, env, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed (exit ${result.status ?? result.signal})`);
  }
}

/**
 * Staleness of the server and CLI builds: the oldest of the dist markers is older than the newest
 * non-test source file of the packages that feed them (or a marker is missing). A fresh checkout
 * or a merge touches many files, which correctly forces a rebuild.
 */
function serverBuildIsStale(): boolean {
  let oldestDist = Infinity;
  for (const marker of SERVER_DIST_MARKERS) {
    const file = path.join(REPO_ROOT, marker);
    if (!existsSync(file)) return true;
    oldestDist = Math.min(oldestDist, statSync(file).mtimeMs);
  }
  const newer = SERVER_SOURCES.find((source) => newestMtime(source) > oldestDist);
  if (newer) console.log(`[irix-e2e] ${newer} is newer than the server build`);
  return newer !== undefined;
}

/** Web UI is stale when the stamp or the bundle is missing, or a source is newer than the stamp. */
function webUiIsStale(): boolean {
  if (!existsSync(WEB_UI_STAMP)) return true;
  if (!existsSync(path.join(REPO_ROOT, "packages/server/dist/server/web-ui/index.html"))) {
    return true;
  }
  const stamp = statSync(WEB_UI_STAMP).mtimeMs;
  const newer = WEB_UI_SOURCES.find((source) => newestMtime(source) > stamp);
  if (newer) console.log(`[irix-e2e] ${newer} is newer than the web UI build`);
  return newer !== undefined;
}

function build(): void {
  if (process.env.IRIX_E2E_SKIP_BUILD === "1") {
    console.log("[irix-e2e] IRIX_E2E_SKIP_BUILD=1: not building");
    return;
  }
  const forced = process.env.IRIX_E2E_REBUILD === "1";
  const env: NodeJS.ProcessEnv = { ...process.env, EXPO_PUBLIC_IRIX: "1" };

  if (forced || serverBuildIsStale()) {
    runNpm(["run", "build:server"], env);
  } else {
    console.log("[irix-e2e] server and CLI builds are fresh");
  }

  if (forced || webUiIsStale()) {
    // Same build the pack does (irix/scripts/pack-local.mjs), minus its Windows and version fixes:
    // it writes packages/server/dist/server/web-ui, which is where the daemon serves it from.
    // build:server above would not touch it; run this after it so a clean build cannot remove it.
    //
    // Metro keeps its transform cache in the system temp folder, shared by every checkout, and
    // keys it on file contents, not on EXPO_PUBLIC_* values: a cache from an earlier pack gave a
    // stale build. (irix/scripts/build-fixes.mjs patches `--clear` into the pack checkout.) Here
    // the build gets a private TMPDIR that is emptied first, which has the same effect without
    // touching an upstream file.
    const buildTmp = path.join(OUTPUT_DIR, "build-tmp");
    rmSync(buildTmp, { recursive: true, force: true });
    mkdirSync(buildTmp, { recursive: true });
    runNpm(["run", "build:daemon-web-ui"], {
      ...env,
      TMPDIR: buildTmp,
    });
    rmSync(buildTmp, { recursive: true, force: true });
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(WEB_UI_STAMP, `${new Date().toISOString()}\n`);
    const now = new Date();
    utimesSync(WEB_UI_STAMP, now, now);
  } else {
    console.log("[irix-e2e] Irix web UI is fresh");
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function pickPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await freePort();
    if (!NEVER_PORTS.has(port)) return port;
  }
  throw new Error("Could not find a free port");
}

/** The daemon's environment: PATH and the basics, plus exactly what Irix e2e sets. */
function daemonEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("PASEO_") || key.startsWith("IRIX_")) continue;
    // A terminal opened inside an agent exports these; they would make the daemon think it
    // runs inside another session.
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) continue;
    env[key] = value;
  }
  env.IRIX_HOME = home;
  env.PASEO_HOME = home;
  return env;
}

async function waitForHttp(url: string, child: { exitCode: number | null }, logFile: string) {
  const deadline = Date.now() + 180_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Irix daemon exited early (code ${child.exitCode}); see ${logFile}`);
    }
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok && body.includes("<html")) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Irix daemon did not serve ${url} in time (${lastError}); see ${logFile}`);
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  build();

  const home = mkdtempSync(path.join(tmpdir(), "irix-e2e-"));
  const port = await pickPort();
  writeFileSync(
    path.join(home, "config.json"),
    `${JSON.stringify({ version: 1, daemon: { listen: `127.0.0.1:${port}`, mcp: { injectIntoAgents: true } } }, null, 2)}\n`,
  );

  // Like `irix daemon run --home <home>`: bin/irix applies the Irix defaults, then the supervisor
  // starts the daemon worker, which activates the Irix edition and serves the web UI.
  const logFile = path.join(OUTPUT_DIR, "daemon.log");
  const log = openSync(logFile, "w");
  const child = spawn(
    process.execPath,
    [path.join(REPO_ROOT, "packages/cli/bin/irix"), "daemon", "run", "--home", home],
    { cwd: REPO_ROOT, env: daemonEnv(home), stdio: ["ignore", log, log] },
  );
  closeSync(log);
  if (!child.pid) throw new Error("Could not start the Irix daemon");

  const baseUrl = `http://127.0.0.1:${port}`;
  const state: DaemonState = { baseUrl, port, home, pid: child.pid };
  // Written before waiting so teardown can stop the daemon even if the wait fails.
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  child.unref();

  await waitForHttp(baseUrl, child, logFile);
  process.env.IRIX_E2E_BASE_URL = baseUrl;
  console.log(`[irix-e2e] Irix daemon on ${baseUrl} (pid ${child.pid}, home ${home})`);
}
