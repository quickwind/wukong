// Irix: applies the brand to a checkout. Run it on a throwaway CI checkout before building,
// never commit its result. The source keeps the upstream name, so upstream's i18n files, icons
// and metadata merge without conflicts and the brand lives in this directory instead.
//
// Every rule must find what it expects. When an upstream change moves or rewrites the target,
// the run fails and names the rule, so a sync cannot silently ship a half-branded build.
//
// Usage: node irix/scripts/brand.mjs [--root <dir>] [--dry-run]

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..", "..");
const OVERLAY_ROOT = path.join(here, "..", "brand", "files");
const BRAND = "Irix";
const UPSTREAM_NAME = /\bPaseo\b/gu;
const ATTRIBUTION_TITLE = "License";
// Shown on the About page. Keep it free of braces and of `$`: it goes into JSX through a regexp.
export const ATTRIBUTION_TEXT =
  "Irix is a modified version of Paseo (github.com/getpaseo/paseo), Copyright (c) 2025-present Mohamed Boudra, licensed under the Apache License 2.0.";

// Source files replaced wholesale. The hash is the upstream version the replacement was
// written against; a different upstream file means the replacement needs another look.
const GUARDED_OVERLAYS = {
  "packages/app/src/components/icons/paseo-logo.tsx":
    "daf84f1ce2598b60b57ea80bbaf0d208e6466da5d6c5d5fd9e142ffa7300680b",
};

// Overlay files that upstream does not have; every other overlay replaces a file upstream ships.
const ADDED_OVERLAYS = new Set([
  "packages/app/src/components/icons/irix-logo-geometry.ts",
  "packages/app/assets/images/web-notification-icon.png",
  "packages/app/public/pwa-icon-16.png",
  "packages/app/public/pwa-icon-24.png",
  "packages/app/public/pwa-icon-32.png",
  "packages/app/public/pwa-icon-48.png",
  "packages/app/public/pwa-icon-256.png",
]);

// An installed Chrome app takes its window, taskbar and desktop icons from the manifest's icon
// list, picking the entry that fits each size. Every PWA icon carries the mark alone so Chrome
// does not select a wordmark for a small Windows surface; the IRIX wordmark remains in icon.png
// and the Apple touch icon.
const MANIFEST_ICONS = [16, 24, 32, 48, 256]
  .map(
    (size) =>
      `\n    { "src": "/pwa-icon-${size}.png", "sizes": "${size}x${size}", "type": "image/png", "purpose": "any" },`,
  )
  .join("");

// Files with no user-visible product name.
const I18N_WITHOUT_NAME = new Set(["plugin-settings.ts"]);

// The skills Paseo installs for agents, and the hints in the command line's own messages ("Use
// `paseo ls` to list agents"), show commands as `paseo <command>`; Irix's command is `irix`, and an
// agent that follows a hint to a command that does not exist wastes a turn. Only a real command is rewritten, so prose such as "the paseo skill" stays. A skill not
// listed here has no command in it; a listed one that loses its commands upstream fails the run.
const CLI_COMMANDS =
  "ls|run|import|clone|attach|logs|stop|delete|send|inspect|wait|archive|onboard|start|hooks|status|" +
  "restart|reload|pair|agent|daemon|hub|terminal|script|schedule|heartbeat|permit|provider|usage|" +
  "plugin|speech|project|workspace|<cmd>|--help|--version";
// Upstream wording that is wrong in Irix: the idle time is 15 minutes (not an hour) and the only
// providers are Claude Code and Devin.
const EN_TEXT_FIXES = [
  {
    pattern: /hint: "Free up memory after an hour of inactivity\."/gu,
    replacement:
      'hint: "Free up memory after 15 minutes of inactivity (the host can change the time with IRIX_IDLE_MINUTES)."',
  },
  {
    pattern:
      /description: "Open a Claude Code, Codex or other session you started in a terminal"/gu,
    replacement: 'description: "Open a Claude Code or Devin session you started in a terminal"',
  },
  {
    pattern: /description: "Configure Claude Code, Codex, and more"/gu,
    replacement: 'description: "Configure Claude Code and Devin"',
  },
];

const SKILL_COMMAND = new RegExp(`\\bpaseo (?=(?:${CLI_COMMANDS})(?![\\w-]))`, "gu");
const SKILLS_WITH_COMMANDS = new Set(["paseo", "paseo-help", "paseo-plugin"]);

// Hashes the text with LF line endings: Git for Windows checks files out with CRLF by default,
// and that must not read as an upstream change.
const sha256 = (buffer) =>
  createHash("sha256").update(buffer.toString("utf8").replaceAll("\r\n", "\n")).digest("hex");

function listOverlayFiles(directory = OVERLAY_ROOT) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    // Finder and Explorer leave these behind in any folder they open.
    if (entry.name === ".DS_Store" || entry.name === "Thumbs.db") return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? listOverlayFiles(full) : [path.relative(OVERLAY_ROOT, full)];
  });
}

// Every non-test source file under the command line, for the hints in its messages.
function cliSourceFiles(root, directory = "packages/cli/src") {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return cliSourceFiles(root, relative);
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [relative] : [];
  });
}

function textRules(root) {
  const i18nDirectory = path.join(root, "packages/app/src/i18n/resources");
  const i18n = readdirSync(i18nDirectory)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => ({
      file: `packages/app/src/i18n/resources/${file}`,
      pattern: UPSTREAM_NAME,
      replacement: BRAND,
      optional: I18N_WITHOUT_NAME.has(file),
    }));
  const skills = readdirSync(path.join(root, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      file: `skills/${entry.name}/SKILL.md`,
      pattern: SKILL_COMMAND,
      replacement: "irix ",
      applied: "irix ",
      optional: !SKILLS_WITH_COMMANDS.has(entry.name),
    }));
  const cliHints = cliSourceFiles(root).map((file) => ({
    file,
    pattern: SKILL_COMMAND,
    replacement: "irix ",
    applied: "irix ",
    // Most files carry no hint; the test below pins the ones that matter.
    optional: true,
  }));
  return [
    ...i18n,
    ...skills,
    ...cliHints,
    // Strings that name things Irix changed or removed. English only: that is the only language
    // Irix ships. Each rule fails the build when its anchor moves, like the others.
    ...EN_TEXT_FIXES.map(({ pattern, replacement }) => ({
      file: "packages/app/src/i18n/resources/en.ts",
      pattern,
      replacement,
      applied: replacement,
    })),
    {
      file: "packages/app/public/manifest.json",
      pattern: /"(name|short_name)": "Paseo"/gu,
      replacement: `"$1": "${BRAND}"`,
    },
    {
      file: "packages/app/public/manifest.json",
      pattern: /("icons": \[)/gu,
      replacement: `$1${MANIFEST_ICONS}`,
      applied: "/pwa-icon-16.png",
    },
    {
      file: "packages/app/src/utils/os-notifications.ts",
      pattern: /require\("\.\.\/\.\.\/assets\/images\/notification-icon\.png"\)/gu,
      replacement: 'require("../../assets/images/web-notification-icon.png")',
      applied: "web-notification-icon.png",
    },
    {
      file: "packages/app/public/index.html",
      pattern: /(apple-mobile-web-app-title" content=")Paseo"/gu,
      replacement: `$1${BRAND}"`,
    },
    {
      file: "packages/app/app.config.js",
      pattern: /name: "Paseo( Debug)?"/gu,
      replacement: `name: "${BRAND}$1"`,
    },
    // Apache-2.0 asks that a modified version says whose work it is. The About page names Paseo
    // and its license, in English whatever the UI language, since it is a legal statement.
    {
      file: "packages/app/src/screens/settings-screen.tsx",
      pattern: /^( *)<WhatsNewRow \/>$/mu,
      replacement: [
        "$1<View style={settingsStyles.row}>",
        "$1  <View style={settingsStyles.rowContent}>",
        `$1    <Text style={settingsStyles.rowTitle}>${ATTRIBUTION_TITLE}</Text>`,
        `$1    <Text style={settingsStyles.rowHint}>${ATTRIBUTION_TEXT}</Text>`,
        "$1  </View>",
        "$1</View>",
        "$1<WhatsNewRow />",
      ].join("\n"),
      applied: ATTRIBUTION_TEXT,
    },
  ];
}

function applyTextRule(root, rule, dryRun, log) {
  const target = path.join(root, rule.file);
  if (!existsSync(target)) {
    throw new Error(`Brand rule target is missing: ${rule.file}`);
  }
  const text = readFileSync(target, "utf8");
  // A rule that adds text the pattern still matches afterwards must not add it twice.
  if (rule.applied && text.includes(rule.applied)) return;
  const matches = text.match(rule.pattern)?.length ?? 0;
  if (matches === 0) {
    // Already branded (a second run) is fine; a target that never had the name is not. A rule
    // for a file that already mentions Irix in its own comments names what it adds in `applied`.
    if (rule.optional || text.includes(rule.applied ?? BRAND)) return;
    throw new Error(`Brand rule found nothing to replace in ${rule.file} (${rule.pattern})`);
  }
  log(`text    ${rule.file} (${matches})`);
  if (!dryRun) writeFileSync(target, text.replace(rule.pattern, rule.replacement));
}

function applyOverlay(root, relative, dryRun, log) {
  const source = path.join(OVERLAY_ROOT, relative);
  const target = path.join(root, relative);
  const replacement = readFileSync(source);
  const guard = GUARDED_OVERLAYS[relative.split(path.sep).join("/")];
  const isNewFile = ADDED_OVERLAYS.has(relative.split(path.sep).join("/"));
  if (!isNewFile && !existsSync(target)) {
    throw new Error(`Brand overlay target is missing (renamed or removed upstream?): ${relative}`);
  }
  if (guard && existsSync(target)) {
    const current = sha256(readFileSync(target));
    if (current !== guard && current !== sha256(replacement)) {
      throw new Error(
        `Upstream changed ${relative}. Review the change, update irix/brand/files and the hash in brand.mjs.`,
      );
    }
  }
  log(`overlay ${relative}`);
  if (!dryRun) {
    writeFileSync(target, replacement);
  }
}

// Irix ships its own command and not `paseo`: a Paseo installed on the same machine owns that
// name, and npm refuses to overwrite it (or, with --force, replaces it). bin/irix also gives
// Irix its own home and port.
function ensureIrixBin(root, dryRun, log) {
  const file = path.join(root, "packages/cli/package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  if (!manifest.bin?.paseo && !manifest.bin?.irix) {
    throw new Error("packages/cli/package.json has no `paseo` bin to replace with `irix`");
  }
  if (!existsSync(path.join(root, "packages/cli/bin/irix"))) {
    throw new Error("packages/cli/bin/irix is missing");
  }
  const wanted = { irix: "bin/irix" };
  if (JSON.stringify(manifest.bin) === JSON.stringify(wanted)) return;
  log("bin     packages/cli/package.json: only `irix` -> bin/irix");
  if (!dryRun) {
    manifest.bin = wanted;
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export function applyBrand({ root = REPO_ROOT, dryRun = false, log = () => {} } = {}) {
  for (const rule of textRules(root)) applyTextRule(root, rule, dryRun, log);
  for (const relative of listOverlayFiles()) applyOverlay(root, relative, dryRun, log);
  ensureIrixBin(root, dryRun, log);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex === -1 ? REPO_ROOT : path.resolve(args[rootIndex + 1] ?? "");
  const dryRun = args.includes("--dry-run");
  applyBrand({
    root,
    dryRun,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  process.stdout.write(`${dryRun ? "Checked" : "Applied"} the ${BRAND} brand in ${root}\n`);
}
