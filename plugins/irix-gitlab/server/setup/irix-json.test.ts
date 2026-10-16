import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { irixJsonPath, readGitLabSaved, writeGitLabSaved } from "./irix-json.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), "irix-home-")), "paseo-home");
  env = { ...process.env, PASEO_HOME: home };
});

describe("irix.json", () => {
  it("lives in the Paseo home", () => {
    expect(irixJsonPath(env)).toBe(join(home, "irix.json"));
  });

  it("reads nothing when the file is absent", () => {
    expect(readGitLabSaved(env)).toEqual({
      url: null,
      configSection: null,
      cloneRoot: null,
      command: null,
    });
  });

  it("creates the file and the home folder on first write", () => {
    writeGitLabSaved({ url: "https://gl.example.com", configSection: "irix" }, env);
    expect(JSON.parse(readFileSync(irixJsonPath(env), "utf8"))).toEqual({
      gitlab: { url: "https://gl.example.com", configSection: "irix" },
    });
  });

  it("keeps other gitlab keys and other top-level keys", () => {
    writeFileSync(
      irixJsonPath({ PASEO_HOME: (writeGitLabSaved({}, env), home) }),
      '﻿{"gitlab":{"sshHost":"h:22","cloneRoot":"~/old"},"other":1}',
    );
    writeGitLabSaved({ configSection: "corp", cloneRoot: "~/projects" }, env);
    expect(JSON.parse(readFileSync(irixJsonPath(env), "utf8"))).toEqual({
      gitlab: { sshHost: "h:22", cloneRoot: "~/projects", configSection: "corp" },
      other: 1,
    });
  });

  it("reads a command array", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(irixJsonPath(env), '{"gitlab":{"command":["uv","run","gitlab"]}}');
    expect(readGitLabSaved(env).command).toEqual(["uv", "run", "gitlab"]);
  });

  it("does not expand ~ in cloneRoot", () => {
    writeGitLabSaved({ cloneRoot: "~/projects" }, env);
    expect(readGitLabSaved(env).cloneRoot).toBe("~/projects");
  });

  it("refuses to overwrite a malformed file", () => {
    writeGitLabSaved({}, env);
    const path = irixJsonPath(env);
    writeFileSync(path, "{ not json");
    expect(() => writeGitLabSaved({ url: "https://gl.example.com" }, env)).toThrow(/Cannot read/);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});
