import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readPaseoConfig } from "../utils/paseo-config-file.js";
import { activateIrixPolicy } from "./policy.js";
import { mergeProjectConfigs, resetIrixProjectConfigForTests } from "./project-config.js";

let root: string;
let deactivate: (() => void) | undefined;

async function write(name: string, content: unknown): Promise<void> {
  await writeFile(
    path.join(root, name),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

async function scriptsOf(): Promise<Record<string, unknown> | undefined> {
  const result = await readPaseoConfig(root);
  if (!result.ok) throw new Error("config unreadable");
  return result.config?.scripts;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "irix-project-config-"));
  resetIrixProjectConfigForTests();
  deactivate = activateIrixPolicy();
});

afterEach(async () => {
  deactivate?.();
  await rm(root, { recursive: true, force: true });
});

describe(".irix.json next to paseo.json", () => {
  it("is read when it is the only file", async () => {
    await write(".irix.json", {
      scripts: { test: { command: "node irix/scripts/test-irix.mjs" } },
    });
    expect(await scriptsOf()).toMatchObject({
      test: { command: "node irix/scripts/test-irix.mjs" },
    });
  });

  it("leaves a project with only paseo.json exactly as it was", async () => {
    await write("paseo.json", { scripts: { web: { command: "npm start" } } });
    expect(await scriptsOf()).toMatchObject({ web: { command: "npm start" } });
  });

  it("adds its scripts to paseo.json's, and wins on a name both use (it has priority)", async () => {
    await write("paseo.json", {
      scripts: { web: { command: "npm start" }, lint: { command: "npm run lint" } },
    });
    await write(".irix.json", {
      scripts: { lint: { command: "node irix/lint.mjs" }, test: { command: "node t.mjs" } },
    });
    expect(await scriptsOf()).toMatchObject({
      web: { command: "npm start" },
      lint: { command: "node irix/lint.mjs" },
      test: { command: "node t.mjs" },
    });
  });

  it("replaces paseo.json's worktree section when it sets one, keeps it when it does not", async () => {
    await write("paseo.json", { worktree: { setup: ["npm ci"] } });
    await write(".irix.json", { scripts: { a: { command: "x" } } });
    let result = await readPaseoConfig(root);
    expect(result.ok && result.config?.worktree?.setup).toEqual(["npm ci"]);

    await write(".irix.json", { worktree: { setup: ["npm install"] } });
    result = await readPaseoConfig(root);
    expect(result.ok && result.config?.worktree?.setup).toEqual(["npm install"]);
  });

  it("picks up an edit without a restart", async () => {
    await write(".irix.json", { scripts: { one: { command: "a" } } });
    expect(Object.keys((await scriptsOf()) ?? {})).toEqual(["one"]);
    await write(".irix.json", { scripts: { one: { command: "a" }, two: { command: "bb" } } });
    expect(Object.keys((await scriptsOf()) ?? {}).sort()).toEqual(["one", "two"]);
  });

  it("reports a file that is not JSON, naming .irix.json", async () => {
    await write("paseo.json", { scripts: { web: { command: "npm start" } } });
    await write(".irix.json", "{ not json");
    const result = await readPaseoConfig(root);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.configPath).toBe(path.join(root, ".irix.json"));
  });

  it("keeps a broken paseo.json visible rather than hiding it behind .irix.json", async () => {
    await write("paseo.json", "{ not json");
    await write(".irix.json", { scripts: { a: { command: "x" } } });
    const result = await readPaseoConfig(root);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.configPath).toBe(path.join(root, "paseo.json"));
  });

  it("is ignored outside the Irix edition", async () => {
    deactivate?.();
    deactivate = undefined;
    await write(".irix.json", { scripts: { test: { command: "x" } } });
    const result = await readPaseoConfig(root);
    expect(result.ok && result.config).toBeNull();
  });
});

describe("mergeProjectConfigs", () => {
  it("does not mutate its inputs", () => {
    const base = { scripts: { a: { command: "1" } } };
    const irix = { scripts: { b: { command: "2" } } };
    const merged = mergeProjectConfigs(base, irix);
    expect(merged.scripts).toEqual({ a: { command: "1" }, b: { command: "2" } });
    expect(base.scripts).toEqual({ a: { command: "1" } });
    expect(irix.scripts).toEqual({ b: { command: "2" } });
  });
});
