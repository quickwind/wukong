import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { addLicense, buildNotice, NOTICE, PACKAGES, ripgrepNotice } from "./add-license.mjs";
import { RIPGREP_VERSION } from "./fetch-ripgrep.mjs";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const read = (file) => readFileSync(path.join(REPO, file), "utf8");

const APACHE = "Copyright (c) someone\n\n  Apache License\n  Version 2.0, January 2004\n";

function checkout({ license = APACHE, manifests = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "irix-license-"));
  if (license !== null) writeFileSync(path.join(root, "LICENSE"), license);
  for (const name of PACKAGES) {
    mkdirSync(path.join(root, "packages", name), { recursive: true });
    writeFileSync(
      path.join(root, "packages", name, "package.json"),
      JSON.stringify({ name, version: "1.0.0", files: ["dist"], ...manifests[name] }),
    );
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const manifest = (root, name) =>
  JSON.parse(readFileSync(path.join(root, "packages", name, "package.json"), "utf8"));

test("gives every package the license, the notice and an Apache-2.0 field", () => {
  const { root, cleanup } = checkout();
  try {
    addLicense({ root });
    for (const name of PACKAGES) {
      const dir = path.join(root, "packages", name);
      assert.equal(readFileSync(path.join(dir, "LICENSE"), "utf8"), APACHE);
      const notice = readFileSync(path.join(dir, "NOTICE"), "utf8");
      assert.ok(notice.startsWith(NOTICE));
      // Only the server ships ripgrep, so only its NOTICE carries ripgrep's licenses.
      assert.equal(notice === NOTICE, name !== "server", name);
      assert.equal(manifest(root, name).license, "Apache-2.0");
      assert.deepEqual(manifest(root, name).files, ["dist", "NOTICE"]);
    }
  } finally {
    cleanup();
  }
});

test("the notice names Paseo, its copyright holder, the license and the fact it was modified", () => {
  assert.match(NOTICE, /modified version of Paseo/);
  assert.match(NOTICE, /Copyright \(c\) 2025-present Mohamed Boudra/);
  assert.match(NOTICE, /Apache License, Version 2\.0/);
  assert.match(NOTICE, /Changes made to Paseo/);
});

test("running it twice changes nothing more", () => {
  const { root, cleanup } = checkout();
  try {
    addLicense({ root });
    const once = readFileSync(path.join(root, "packages/server/package.json"), "utf8");
    addLicense({ root });
    assert.equal(readFileSync(path.join(root, "packages/server/package.json"), "utf8"), once);
  } finally {
    cleanup();
  }
});

test("a package without a files list is left without one (everything is packed anyway)", () => {
  const { root, cleanup } = checkout({ manifests: { relay: { files: undefined } } });
  try {
    addLicense({ root });
    assert.equal("files" in manifest(root, "relay"), false);
  } finally {
    cleanup();
  }
});

test("refuses when LICENSE is missing, is not Apache 2.0, or a package claims another license", () => {
  for (const options of [
    { license: null },
    { license: "MIT License\n" },
    { manifests: { cli: { license: "MIT" } } },
  ]) {
    const { root, cleanup } = checkout(options);
    try {
      assert.throws(() => addLicense({ root }));
    } finally {
      cleanup();
    }
  }
});

test("carries over a NOTICE that upstream adds later (Apache-2.0 4d), after ours", () => {
  const { root, cleanup } = checkout();
  try {
    writeFileSync(path.join(root, "NOTICE"), "Paseo\nIncludes software from Example Corp.\n");
    addLicense({ root });
    for (const name of PACKAGES) {
      const text = readFileSync(path.join(root, "packages", name, "NOTICE"), "utf8");
      assert.ok(text.startsWith(NOTICE));
      if (name === "server") assert.ok(text.endsWith(ripgrepNotice()));
      assert.match(
        text,
        /Notice carried over from Paseo's NOTICE file:\n\nPaseo\nIncludes software from Example Corp\./,
      );
    }
    assert.equal(buildNotice("  \n"), NOTICE);
    assert.equal(buildNotice(undefined), NOTICE);
  } finally {
    cleanup();
  }
});

test("the server's NOTICE carries ripgrep's and PCRE2's license texts verbatim", () => {
  const { root, cleanup } = checkout();
  try {
    addLicense({ root });
    const notice = readFileSync(path.join(root, "packages", "server", "NOTICE"), "utf8");
    assert.equal(notice, `${NOTICE}\n${ripgrepNotice()}`);
    assert.match(notice, new RegExp(`ripgrep ${RIPGREP_VERSION.replaceAll(".", "\\.")}`));
    assert.match(notice, /https:\/\/github\.com\/BurntSushi\/ripgrep/);
    for (const file of [
      "irix/licenses/ripgrep/COPYING",
      "irix/licenses/ripgrep/LICENSE-MIT",
      "irix/licenses/ripgrep/UNLICENSE",
      "irix/licenses/pcre2/LICENCE",
    ]) {
      assert.ok(notice.includes(read(file)), file);
    }
    assert.match(read("irix/licenses/ripgrep/LICENSE-MIT"), /Copyright \(c\) 2015 Andrew Gallant/);
    assert.match(read("irix/licenses/pcre2/LICENCE"), /BSD-3-Clause WITH PCRE2-exception/);
  } finally {
    cleanup();
  }
});
