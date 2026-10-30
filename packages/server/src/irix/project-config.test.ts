import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readPaseoConfig,
  readPaseoConfigForEdit,
  resolvePaseoConfigPath,
  writePaseoConfigForEdit,
} from "../utils/paseo-config-file.js";
import { activateIrixPolicy } from "./policy.js";

let root: string;
let deactivate: (() => void) | undefined;

async function write(name: string, content: unknown): Promise<void> {
  await writeFile(
    path.join(root, name),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

async function scriptNames(): Promise<string[]> {
  const result = await readPaseoConfig(root);
  if (!result.ok) throw new Error("config unreadable");
  return Object.keys(result.config?.scripts ?? {}).sort();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "irix-project-config-"));
  deactivate = activateIrixPolicy();
});

afterEach(async () => {
  deactivate?.();
  await rm(root, { recursive: true, force: true });
});

describe(".irix.json in place of paseo.json", () => {
  it("is read when it is the only file", async () => {
    await write(".irix.json", {
      scripts: { test: { command: "node irix/scripts/test-irix.mjs" } },
    });
    expect(await scriptNames()).toEqual(["test"]);
  });

  it("leaves a project with only paseo.json exactly as it was", async () => {
    await write("paseo.json", { scripts: { web: { command: "npm start" } } });
    expect(await scriptNames()).toEqual(["web"]);
    expect(await resolvePaseoConfigPath(root)).toBe(path.join(root, "paseo.json"));
  });

  it("is the only file read when both exist", async () => {
    await write("paseo.json", {
      worktree: { setup: ["npm ci"] },
      scripts: { web: { command: "npm start" }, shared: { command: "from paseo" } },
    });
    await write(".irix.json", {
      scripts: { shared: { command: "from irix" }, only_irix: { command: "node b.js" } },
    });
    expect(await scriptNames()).toEqual(["only_irix", "shared"]);
    const result = await readPaseoConfig(root);
    expect(result.ok && result.config?.scripts?.shared).toMatchObject({ command: "from irix" });
    expect(result.ok && result.config?.worktree).toBeUndefined();
  });

  it("is ignored when paseo.json is broken, and reported under its own name when it is", async () => {
    await write("paseo.json", "{ not json");
    await write(".irix.json", { scripts: { a: { command: "x" } } });
    expect(await scriptNames()).toEqual(["a"]);

    await write(".irix.json", "{ not json");
    const result = await readPaseoConfig(root);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.configPath).toBe(path.join(root, ".irix.json"));
  });

  it("picks up an edit without a restart, and a deleted file hands over to paseo.json", async () => {
    await write("paseo.json", { scripts: { fromPaseo: { command: "p" } } });
    await write(".irix.json", { scripts: { one: { command: "a" } } });
    expect(await scriptNames()).toEqual(["one"]);
    await write(".irix.json", { scripts: { one: { command: "a" }, two: { command: "bb" } } });
    expect(await scriptNames()).toEqual(["one", "two"]);
    await rm(path.join(root, ".irix.json"));
    expect(await scriptNames()).toEqual(["fromPaseo"]);
  });

  it("is what the project config editor reads and writes", async () => {
    await write("paseo.json", { scripts: { fromPaseo: { command: "p" } } });
    await write(".irix.json", { scripts: { fromIrix: { command: "i" } } });

    const edit = await readPaseoConfigForEdit(root);
    expect(edit.ok && Object.keys(edit.config?.scripts ?? {})).toEqual(["fromIrix"]);
    if (!edit.ok || !edit.config) throw new Error("editor could not read .irix.json");

    const saved = await writePaseoConfigForEdit({
      repoRoot: root,
      config: { ...edit.config, scripts: { ...edit.config.scripts, added: { command: "n" } } },
      expectedRevision: edit.revision,
    });
    expect(saved.ok).toBe(true);

    const irixFile = JSON.parse(await readFile(path.join(root, ".irix.json"), "utf8"));
    expect(Object.keys(irixFile.scripts).sort()).toEqual(["added", "fromIrix"]);
    const paseoFile = JSON.parse(await readFile(path.join(root, "paseo.json"), "utf8"));
    expect(Object.keys(paseoFile.scripts)).toEqual(["fromPaseo"]);
  });

  it("is not used by the editor without it: it writes paseo.json as before", async () => {
    await write("paseo.json", { scripts: { fromPaseo: { command: "p" } } });
    const edit = await readPaseoConfigForEdit(root);
    if (!edit.ok || !edit.config) throw new Error("editor could not read paseo.json");
    const saved = await writePaseoConfigForEdit({
      repoRoot: root,
      config: { ...edit.config, scripts: { ...edit.config.scripts, added: { command: "n" } } },
      expectedRevision: edit.revision,
    });
    expect(saved.ok).toBe(true);
    const paseoFile = JSON.parse(await readFile(path.join(root, "paseo.json"), "utf8"));
    expect(Object.keys(paseoFile.scripts).sort()).toEqual(["added", "fromPaseo"]);
  });

  it("is ignored outside the Irix edition", async () => {
    deactivate?.();
    deactivate = undefined;
    await write(".irix.json", { scripts: { test: { command: "x" } } });
    const result = await readPaseoConfig(root);
    expect(result.ok && result.config).toBeNull();
    expect(await resolvePaseoConfigPath(root)).toBe(path.join(root, "paseo.json"));
  });
});
