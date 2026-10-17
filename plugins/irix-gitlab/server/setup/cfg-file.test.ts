import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  assertCfgValue,
  cfgPath,
  freeSectionName,
  readCfgSections,
  upsertSection,
} from "./cfg-file.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "irix-cfg-"));
  file = join(dir, ".python-gitlab.cfg");
});

describe("cfgPath", () => {
  it("prefers PYTHON_GITLAB_CFG, then the home file", () => {
    expect(cfgPath({ PYTHON_GITLAB_CFG: "/x/y.cfg" })).toBe("/x/y.cfg");
    expect(cfgPath({}).endsWith(".python-gitlab.cfg")).toBe(true);
  });
});

describe("readCfgSections", () => {
  it("is empty when the file is absent", () => {
    expect(readCfgSections(file)).toEqual([]);
  });

  it("lists sections with their urls and skips global", () => {
    writeFileSync(
      file,
      "[global]\ndefault = a\n\n[a]\nurl = https://a.example.com\nprivate_token = x\n\n[b]\nurl=https://b.example.com\nprivate_token = helper: pass show gl\n",
    );
    expect(readCfgSections(file)).toEqual([
      { name: "a", url: "https://a.example.com" },
      { name: "b", url: "https://b.example.com" },
    ]);
  });

  it("gives a section with no url a null url", () => {
    writeFileSync(file, "[odd]\nprivate_token = x\n");
    expect(readCfgSections(file)).toEqual([{ name: "odd", url: null }]);
  });
});

describe("upsertSection", () => {
  it("creates the file with global default, mode 0600 and api_version 4", () => {
    upsertSection(file, { name: "irix", url: "https://gl.example.com", token: "tok" });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("[global]\ndefault = irix");
    expect(text).toContain(
      "[irix]\nurl = https://gl.example.com\nprivate_token = tok\napi_version = 4",
    );
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps an existing global section and everything else byte for byte", () => {
    const original =
      "﻿# mine\r\n[global]\r\ndefault = old\r\n\r\n[old]\r\nurl = https://old.example.com\r\nprivate_token = keep\r\n";
    writeFileSync(file, original);
    upsertSection(file, { name: "irix", url: "https://gl.example.com", token: "tok" });
    const text = readFileSync(file, "utf8");
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain("[irix]");
    expect(text.match(/\[global\]/g)).toHaveLength(1);
  });

  it("replaces only the token and url lines of an existing section", () => {
    writeFileSync(
      file,
      "[a]\nurl = https://a.example.com\nprivate_token = old\nssl_verify = false\n\n[b]\nurl = https://b.example.com\nprivate_token = b\n",
    );
    upsertSection(file, { name: "a", url: "https://a.example.com", token: "new" });
    expect(readFileSync(file, "utf8")).toBe(
      "[a]\nurl = https://a.example.com\nprivate_token = new\nssl_verify = false\n\n[b]\nurl = https://b.example.com\nprivate_token = b\n",
    );
  });
});

describe("freeSectionName", () => {
  it("avoids existing names and global", () => {
    expect(freeSectionName([])).toBe("irix");
    expect(freeSectionName(["irix", "global"])).toBe("irix-2");
    expect(freeSectionName(["irix", "irix-2"])).toBe("irix-3");
  });
});

describe("assertCfgValue", () => {
  it("accepts a plain value", () => {
    expect(() => assertCfgValue("token", "glpat-abc_123")).not.toThrow();
  });

  it.each(["", "a\nb", "a\rb", " x", "x ", "a\u0000b"])("rejects %j", (value) => {
    expect(() => assertCfgValue("token", value)).toThrow(/token/);
  });
});
