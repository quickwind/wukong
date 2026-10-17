// Builds the Irix npm packages as tarballs the way the publish workflow does, without
// publishing anything. Runs on Windows, macOS and Linux.
//
// It works in a throwaway checkout of the last commit, so your working tree is left alone
// (commit first: uncommitted changes are not included).
//
// Usage: node irix/scripts/pack-local.mjs --out <dir> [--scope irix] [--work-dir <dir>] [--keep]
//   --out       where the .tgz files and the .zip bundle go (required); the files of an earlier
//               build there are removed. The bundle holds the seven tarballs, windows-update.ps1
//               and INSTALL-WINDOWS.md: one file to hand out, unzip and run the script
//   --scope     npm scope, giving @<scope>/cli, @<scope>/server, ... (default: irix)
//   --work-dir  where the throwaway checkout lives. Keep it short on Windows (default: a
//               short folder under the system temp directory)
//   --keep      leave the checkout in place afterwards (for debugging)

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export function parseArgs(argv) {
  const args = { out: "", scope: "irix", workDir: "", keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[index];
    };
    if (arg === "--out") args.out = next();
    else if (arg === "--scope") args.scope = next().replace(/^@/u, "");
    else if (arg === "--work-dir") args.workDir = next();
    else if (arg === "--keep") args.keep = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.out) throw new Error("--out is required");
  if (!SCOPE_PATTERN.test(args.scope)) {
    throw new Error("--scope must be a lowercase npm scope such as `irix`");
  }
  if (args.scope === "getpaseo") throw new Error("Refusing to use the upstream @getpaseo scope");
  return args;
}

/** `0.11.2-beta.1` -> `0.11.2`: the upstream version without its prerelease. */
export function coreVersion(version) {
  return version.split("-")[0];
}

/** A build stamp that sorts in time order: 202610101530 (UTC). */
export function buildStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`
  );
}

/** A tarball of this scope from an earlier build, such as `irix-cli-0.11.2-irix.1.tgz`. */
export function staleTarball(file, scope) {
  return PACKAGES.some((pkg) => file.startsWith(`${scope}-${pkg}-`)) && file.endsWith(".tgz");
}

/** An earlier bundle of this scope, such as `irix-0.11.2-irix.1.zip`. */
export function staleBundle(file, scope) {
  return new RegExp(`^${scope}-\\d`).test(file) && file.endsWith(".zip");
}

const isWindows = process.platform === "win32";

function quote(argument) {
  return /[\s"]/u.test(argument) ? `"${argument.replaceAll('"', '\\"')}"` : argument;
}

/** Runs a command, inheriting output. npm needs a shell on Windows because it is a .cmd file. */
function run(command, args, options = {}) {
  const useShell = isWindows && command === "npm";
  const result = useShell
    ? spawnSync([command, ...args].map(quote).join(" "), {
        stdio: "inherit",
        shell: true,
        ...options,
      })
    : spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${command} ${args.join(" ")}`);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${command} ${args.join(" ")}`);
  }
  return result.stdout.trim();
}

/**
 * The commands that may write the zip, best first. Node has no zip writer. On Windows `tar` can be
 * GNU tar (Git for Windows puts its Unix tools on PATH), which cannot write zip and misreads
 * `C:\\...` as host:file, so the system's bsdtar comes first and PowerShell is the last resort.
 */
export function zipAttempts({
  platform = process.platform,
  systemRoot = process.env.SystemRoot,
  zipFile,
  members,
}) {
  const tarArgs = ["-a", "-cf", zipFile, ...members];
  const attempts = [];
  if (platform === "win32") {
    attempts.push([path.win32.join(systemRoot || "C:\\Windows", "System32", "tar.exe"), tarArgs]);
  }
  attempts.push(["tar", tarArgs], ["zip", ["-q", zipFile, ...members]]);
  if (platform === "win32") {
    const quoted = (text) => `'${text.replaceAll("'", "''")}'`;
    attempts.push([
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -LiteralPath ${members.map(quoted).join(",")} ` +
          `-DestinationPath ${quoted(zipFile)} -Force`,
      ],
    ]);
  }
  return attempts;
}

/** Zips `members` (names inside `directory`) into `zipFile`, with them at the top of the zip. */
export function makeZip(zipFile, directory, members) {
  rmSync(zipFile, { force: true });
  for (const [command, args] of zipAttempts({ zipFile, members })) {
    const result = spawnSync(command, args, { cwd: directory, encoding: "utf8" });
    if (!result.error && result.status === 0 && existsSync(zipFile)) return;
    rmSync(zipFile, { force: true });
  }
  throw new Error("Could not write the zip: none of tar, zip or PowerShell worked");
}

function removeTree(directory) {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export function main(argv) {
  const args = parseArgs(argv);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const stamp = buildStamp();
  const work = path.resolve(args.workDir || path.join(tmpdir(), `irix-${stamp}`));
  const out = path.resolve(args.out);

  const hasChanges = Boolean(capture("git", ["status", "--porcelain"], { cwd: repo }));
  if (hasChanges) {
    process.stdout.write(
      "Note: applying working tree changes (including uncommitted adjustments) to the build worktree.\n",
    );
  }
  if (existsSync(work)) throw new Error(`${work} already exists; pass another --work-dir`);

  // core.longpaths: node_modules nests deeply and Windows stops at 260 characters by default.
  run("git", ["-c", "core.longpaths=true", "worktree", "add", "--detach", work, "HEAD"], {
    cwd: repo,
  });

  // Apply uncommitted changes from the working tree so local adjustments (such as brand assets)
  // are included in the local package build.
  const diffResult = spawnSync("git", ["diff", "--binary", "HEAD"], {
    cwd: repo,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (diffResult.stdout && diffResult.stdout.length > 0) {
    const apply = spawnSync("git", ["apply", "--binary"], {
      cwd: work,
      input: diffResult.stdout,
    });
    if (apply.status !== 0) {
      throw new Error(`Failed to apply working tree diff to ${work}: ${apply.stderr?.toString()}`);
    }
  }
  const untracked = capture("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repo })
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const rel of untracked) {
    const src = path.join(repo, rel);
    const dest = path.join(work, rel);
    if (existsSync(src)) {
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(src, dest, { force: true, recursive: true });
    }
  }
  spawnSync("git", ["add", "-A"], { cwd: work });

  try {
    const env = {
      ...process.env,
      EXPO_PUBLIC_IRIX: "1",
      ONNXRUNTIME_NODE_INSTALL: "skip",
    };
    const node = process.execPath;
    const inWork = { cwd: work, env };

    run(node, ["irix/scripts/rename-npm-scope.mjs", "--scope", args.scope], inWork);
    run(node, ["irix/scripts/brand.mjs"], inWork);
    // Upstream's web UI build cannot start npm on Windows; fixed in this checkout only.
    run(node, ["irix/scripts/build-fixes.mjs"], inWork);

    run(
      node,
      ["scripts/npm-retry.mjs", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      inWork,
    );
    run("npm", ["run", "postinstall"], inWork);

    const core = coreVersion(
      JSON.parse(
        capture(node, ["-p", "JSON.stringify(require('./package.json').version)"], inWork),
      ),
    );
    const version = `${core}-irix.${stamp}`;
    // The web UI is built later, while packing the server; its About page shows this version.
    env.EXPO_PUBLIC_IRIX_VERSION = version;
    run("npm", ["pkg", "set", `version=${version}`], inWork);
    run(node, ["scripts/sync-workspace-versions.mjs"], inWork);
    // The app is not published, and its Expo config only accepts x.y.z or x.y.z-beta.N.
    run("npm", ["pkg", "set", `version=${core}`, `--workspace=@${args.scope}/app`], inWork);

    // Apache-2.0 §4: every package ships upstream's LICENSE and a NOTICE.
    run(node, ["irix/scripts/add-license.mjs"], inWork);

    const packed = path.join(work, "dist-npm");
    mkdirSync(packed, { recursive: true });
    for (const name of PACKAGES) {
      run(
        "npm",
        ["pack", `--workspace=@${args.scope}/${name}`, "--pack-destination", packed],
        inWork,
      );
    }

    mkdirSync(out, { recursive: true });
    // Tarballs of an earlier build in the same folder would be installed alongside the new ones.
    for (const file of readdirSync(out)) {
      if (staleTarball(file, args.scope) || staleBundle(file, args.scope)) {
        rmSync(path.join(out, file), { force: true });
      }
    }
    const tarballs = readdirSync(packed).filter((file) => file.endsWith(".tgz"));
    for (const file of tarballs) cpSync(path.join(packed, file), path.join(out, file));

    // One file to hand out: the tarballs with the script that installs them and the guide.
    const stage = path.join(packed, "bundle");
    mkdirSync(stage, { recursive: true });
    const helpers = [
      "irix/scripts/windows-update.ps1",
      "irix/scripts/windows-autostart.ps1",
      "irix/INSTALL-WINDOWS.md",
    ];
    for (const file of tarballs) cpSync(path.join(packed, file), path.join(stage, file));
    for (const file of helpers)
      cpSync(path.join(work, file), path.join(stage, path.basename(file)));
    const bundle = `${args.scope}-${version}.zip`;
    makeZip(path.join(out, bundle), stage, [...tarballs, ...helpers.map((f) => path.basename(f))]);

    process.stdout.write(`\nPacked ${version}: ${tarballs.length} tarballs in ${out}\n`);
    for (const file of tarballs) process.stdout.write(`  ${file}\n`);
    process.stdout.write(`Bundle for handing out: ${path.join(out, bundle)}\n`);
  } finally {
    if (args.keep) {
      process.stdout.write(`Kept the checkout at ${work}\n`);
    } else {
      removeTree(work);
      spawnSync("git", ["worktree", "prune"], { cwd: repo });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
