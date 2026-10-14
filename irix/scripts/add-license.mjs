// Irix: puts the license where Apache-2.0 §4 wants it. Run on a throwaway checkout before
// `npm pack` (after the scope rename and the brand), never commit its result.
//
// Each published package gets a copy of upstream's LICENSE and a NOTICE that says it is a modified
// version of Paseo, and its package.json says `license: Apache-2.0`. Upstream's root LICENSE is not
// in the package folders, so npm would otherwise pack none.
//
// Usage: node irix/scripts/add-license.mjs [--root <dir>]

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PACKAGES = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];
const LICENSE_ID = "Apache-2.0";

export const NOTICE = `Irix
This product is a modified version of Paseo (https://github.com/getpaseo/paseo).

Paseo
Copyright (c) 2025-present Mohamed Boudra
Licensed under the Apache License, Version 2.0 (see LICENSE).

Changes made to Paseo: the daemon only connects to this machine and to an allowlist of hosts;
the agent providers are limited to Claude Code and Devin CLI; plugins load from local folders
only; GitLab replaces GitHub and the GitHub CLI; the web UI is served by the daemon and drops
voice, pairing and upstream links; usage is shown for Devin; the product has a new name, logo
and icons, and its own command, home folder and port. Files of Paseo that were modified carry an
"Irix" comment.

Third-party components included in this product remain licensed under the licenses provided by
their respective copyright holders.
`;

/** Apache-2.0 §4d: if upstream ever ships a NOTICE, its text must travel with ours. */
export function buildNotice(upstreamNotice) {
  const carried = upstreamNotice?.trim();
  return carried
    ? `${NOTICE}\nNotice carried over from Paseo's NOTICE file:\n\n${carried}\n`
    : NOTICE;
}

export function addLicense({ root = REPO_ROOT, log = () => {} } = {}) {
  const licenseFile = path.join(root, "LICENSE");
  if (!existsSync(licenseFile)) throw new Error("LICENSE is missing from the repository root");
  const license = readFileSync(licenseFile, "utf8");
  if (!/Apache License/u.test(license) || !/Version 2\.0/u.test(license)) {
    throw new Error(
      "LICENSE is no longer the Apache License 2.0. Review the upstream change before shipping.",
    );
  }
  const upstreamNoticeFile = path.join(root, "NOTICE");
  const notice = buildNotice(
    existsSync(upstreamNoticeFile) ? readFileSync(upstreamNoticeFile, "utf8") : undefined,
  );
  if (notice !== NOTICE) log("notice  carrying over upstream's NOTICE");
  for (const name of PACKAGES) {
    const directory = path.join(root, "packages", name);
    const manifestFile = path.join(directory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (manifest.license && manifest.license !== LICENSE_ID) {
      throw new Error(`${name} declares license ${manifest.license}, not ${LICENSE_ID}`);
    }
    copyFileSync(licenseFile, path.join(directory, "LICENSE"));
    writeFileSync(path.join(directory, "NOTICE"), notice);
    manifest.license = LICENSE_ID;
    // LICENSE is always packed; NOTICE only when `files` lists it.
    if (Array.isArray(manifest.files) && !manifest.files.includes("NOTICE")) {
      manifest.files.push("NOTICE");
    }
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    log(`license packages/${name}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--root");
  const root = index === -1 ? REPO_ROOT : path.resolve(process.argv[index + 1] ?? "");
  addLicense({ root, log: (line) => process.stdout.write(`${line}\n`) });
}
