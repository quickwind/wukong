import assert from "node:assert/strict";
import test from "node:test";

import { RIPGREP_VERSION } from "./fetch-ripgrep.mjs";
import { audit, classify, shippedPackages, VENDORED } from "./license-audit.mjs";

const lock = {
  packages: {
    "": { name: "root" },
    "packages/server": {
      dependencies: { alpha: "1", nested: "1", "@scope/linked": "1" },
      optionalDependencies: { native: "1" },
      devDependencies: { "dev-only": "1" },
    },
    "packages/app": { dependencies: { "app-only": "1" } },
    "node_modules/alpha": { version: "1.0.0", license: "MIT", dependencies: { beta: "1" } },
    "node_modules/beta": { version: "2.0.0", license: "(MIT OR GPL-3.0-or-later)" },
    "packages/server/node_modules/nested": { version: "3.0.0", license: "Apache-2.0" },
    "node_modules/native": { version: "1.0.0", license: "LGPL-3.0-or-later", optional: true },
    "node_modules/@scope/linked": { resolved: "packages/linked", link: true },
    "packages/linked": { dependencies: { gamma: "1" } },
    "node_modules/gamma": { version: "1.0.0", license: "GPL-3.0" },
    "node_modules/dev-only": { version: "1.0.0", license: "BUSL-1.1", dev: true },
    "node_modules/app-only": { version: "1.0.0", license: "AGPL-3.0" },
  },
};
const byName = (rows) => Object.fromEntries(rows.map((row) => [row.name, row.level]));

test("walks only what the published packages depend on, nested and through workspace links", () => {
  const names = shippedPackages(lock).map(([key]) => key.replace(/^.*node_modules\//u, ""));
  assert.deepEqual(names.sort(), ["alpha", "beta", "gamma", "native", "nested"]);
});

test("leaves out dev dependencies and packages only the unpublished app needs", () => {
  const rows = byName(audit(lock));
  assert.equal("dev-only" in rows, false);
  assert.equal("app-only" in rows, false);
});

test("sorts licenses into ok, review and blocked", () => {
  assert.deepEqual(byName(audit(lock)), {
    alpha: "ok",
    beta: "ok", // MIT or GPL: the MIT reading applies
    gamma: "blocked",
    native: "review",
    nested: "ok",
  });
});

test("classifies expressions by their worst applicable reading", () => {
  const cases = {
    MIT: "ok",
    "(MPL-2.0 OR Apache-2.0)": "ok",
    "Apache-2.0 AND LGPL-3.0-or-later": "review",
    "MPL-2.0": "review",
    "CC-BY-4.0": "review",
    "SEE LICENSE IN LICENSE.md": "review",
    "GPL-3.0": "blocked",
    "AGPL-3.0-only": "blocked",
    "BUSL-1.1": "blocked",
    UNLICENSED: "blocked",
    "GPL-2.0 OR AGPL-3.0": "blocked",
    // An exception only adds permissions, so the base license decides.
    "BSD-3-Clause WITH PCRE2-exception": "ok",
    "GPL-2.0-only WITH Classpath-exception-2.0": "blocked",
  };
  for (const [expression, level] of Object.entries(cases)) {
    assert.equal(classify(expression), level, expression);
  }
  assert.equal(classify(undefined), "review");
});

test("--since keeps only packages the lockfile gained", () => {
  const before = {
    packages: Object.fromEntries(
      Object.entries(lock.packages).filter(
        ([key]) => !key.endsWith("/gamma") && !key.endsWith("/native"),
      ),
    ),
  };
  assert.deepEqual(byName(audit(lock, before)), { gamma: "blocked", native: "review" });
});

test("lists the vendored ripgrep binary and the PCRE2 inside it as permissive", () => {
  const rows = audit({ packages: {} }, null, VENDORED);
  assert.deepEqual(
    rows.map(({ name, version, level }) => [name, version, level]),
    [
      ["pcre2 (in the ripgrep binary)", "10.46", "ok"],
      ["ripgrep (binary in @irix/server)", RIPGREP_VERSION, "ok"],
    ],
  );
});

test("--since lists a vendored component only when it or its version is new", () => {
  const ripgrep = VENDORED.find((entry) => entry.name.startsWith("ripgrep"));
  const others = VENDORED.filter((entry) => entry !== ripgrep);
  const empty = { packages: {} };
  assert.deepEqual(
    audit(empty, empty, VENDORED, others).map((row) => row.name),
    [ripgrep.name],
  );
  assert.deepEqual(audit(empty, empty, VENDORED, VENDORED), []);
  const older = [{ ...ripgrep, version: "14.0.0" }, ...others];
  assert.deepEqual(
    audit(empty, empty, VENDORED, older).map((row) => row.name),
    [ripgrep.name],
  );
});

test("vendored.json names the ripgrep version fetch-ripgrep.mjs pins", () => {
  const ripgrep = VENDORED.find((entry) => entry.name.startsWith("ripgrep"));
  assert.equal(ripgrep.version, RIPGREP_VERSION);
});
