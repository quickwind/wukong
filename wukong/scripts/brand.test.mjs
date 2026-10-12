import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyBrand, ATTRIBUTION_TEXT } from "./brand.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

// The files the brand touches, copied so the test never modifies the working tree.
const TOUCHED = [
  "packages/app/src/i18n/resources",
  "packages/app/public/manifest.json",
  "packages/app/public/index.html",
  "packages/app/app.config.js",
  "packages/app/src/components/icons/paseo-logo.tsx",
  "packages/app/src/screens/settings-screen.tsx",
  "packages/app/assets/images",
  "packages/app/public",
  "packages/cli/package.json",
  "packages/cli/bin",
  "skills",
];

function copyTree() {
  const root = mkdtempSync(path.join(tmpdir(), "wukong-brand-"));
  for (const relative of TOUCHED) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(repoRoot, relative), target, { recursive: true });
  }
  return root;
}

const read = (root, relative) =>
  readFileSync(path.join(root, relative), "utf8");

test("every rule still matches upstream (this fails after a sync that moves a target)", () => {
  applyBrand({ root: repoRoot, dryRun: true });
});

test("rewrites the commands in the agent skills to `wukong`, and leaves prose alone", () => {
  const root = copyTree();
  applyBrand({ root });
  const skill = read(root, "skills/paseo/SKILL.md");
  assert.match(skill, /wukong send <agent-id>/u);
  assert.match(skill, /wukong ls/u);
  assert.doesNotMatch(skill, /\bpaseo (run|send|ls|project|--help)\b/u);
  assert.match(
    read(root, "skills/paseo-handoff/SKILL.md"),
    /\*\*paseo\*\* skill/u
  );
  applyBrand({ root });
});

test("brands the name, metadata, logo and CLI alias", () => {
  const root = copyTree();
  applyBrand({ root });

  assert.match(read(root, "packages/app/src/i18n/resources/en.ts"), /Wukong/);
  assert.doesNotMatch(
    read(root, "packages/app/src/i18n/resources/en.ts"),
    /\bPaseo\b/
  );
  assert.match(
    read(root, "packages/app/public/manifest.json"),
    /"short_name": "Wukong"/
  );
  assert.match(
    read(root, "packages/app/public/index.html"),
    /app-title" content="Wukong"/
  );
  assert.match(
    read(root, "packages/app/app.config.js"),
    /name: "Wukong Debug"/
  );
  assert.match(
    read(root, "packages/app/src/components/icons/paseo-logo.tsx"),
    /WUKONG_LOGO/
  );
  assert.deepEqual(JSON.parse(read(root, "packages/cli/package.json")).bin, {
    wukong: "bin/wukong",
  });
});

test("the About page says whose work this is, once, even if the brand runs twice", () => {
  const root = copyTree();
  const screen = "packages/app/src/screens/settings-screen.tsx";
  assert.equal(read(root, screen).includes(ATTRIBUTION_TEXT), false);
  applyBrand({ root });
  applyBrand({ root });
  const text = read(root, screen);
  assert.equal(text.split(ATTRIBUTION_TEXT).length - 1, 1);
  assert.match(
    ATTRIBUTION_TEXT,
    /modified version of Paseo.*Mohamed Boudra.*Apache License 2\.0/
  );
  // Inside the About card, ahead of the (hidden in Wukong) What's new row.
  assert.ok(text.indexOf(ATTRIBUTION_TEXT) < text.indexOf("<WhatsNewRow />"));
});

test("is idempotent", () => {
  const root = copyTree();
  applyBrand({ root });
  const once = read(root, "packages/app/src/i18n/resources/en.ts");
  applyBrand({ root });
  assert.equal(read(root, "packages/app/src/i18n/resources/en.ts"), once);
});

test("fails loudly when upstream rewrites a guarded file", () => {
  const root = copyTree();
  const logo = path.join(
    root,
    "packages/app/src/components/icons/paseo-logo.tsx"
  );
  writeFileSync(logo, `${readFileSync(logo, "utf8")}\n// upstream change\n`);
  assert.throws(
    () => applyBrand({ root }),
    /Upstream changed .*paseo-logo\.tsx/
  );
});

test("fails loudly when a text target loses the name", () => {
  const root = copyTree();
  writeFileSync(
    path.join(root, "packages/app/public/manifest.json"),
    '{"id":"/"}\n'
  );
  assert.throws(
    () => applyBrand({ root }),
    /found nothing to replace in .*manifest\.json/
  );
});

test("a Windows checkout with CRLF line endings is not an upstream change", () => {
  const root = copyTree();
  const logo = path.join(
    root,
    "packages/app/src/components/icons/paseo-logo.tsx"
  );
  // A Windows checkout may already be CRLF: go through LF first so the file is CRLF, not CR CR LF.
  writeFileSync(
    logo,
    readFileSync(logo, "utf8").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n")
  );
  applyBrand({ root });
  assert.match(
    read(root, "packages/app/src/components/icons/paseo-logo.tsx"),
    /WUKONG_LOGO/
  );
});
