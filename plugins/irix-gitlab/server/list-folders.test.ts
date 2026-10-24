import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createFolder,
  folderNameProblem,
  listFolders,
  shortcutsFor,
  type ListFoldersEnv,
} from "./list-folders.js";

function envFor(home: string, overrides: Partial<ListFoldersEnv> = {}): ListFoldersEnv {
  return { platform: process.platform, home, env: {}, exists: () => true, ...overrides };
}

describe("listFolders", () => {
  it("lists only visible folders, sorted, with their full paths", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "irix-folders-"));
    mkdirSync(path.join(root, "beta"));
    mkdirSync(path.join(root, "Alpha"));
    mkdirSync(path.join(root, ".hidden"));
    writeFileSync(path.join(root, "file.txt"), "x");

    const listing = await listFolders(root, envFor(root));

    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(path.dirname(root));
    expect(listing.folders).toEqual([
      { name: "Alpha", path: path.join(root, "Alpha") },
      { name: "beta", path: path.join(root, "beta") },
    ]);
  });

  it("starts in the home folder when no path is given", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "irix-home-"));
    expect((await listFolders(undefined, envFor(home))).path).toBe(home);
  });

  it("has no parent at the top of the disk", async () => {
    const top = path.parse(process.cwd()).root;
    expect((await listFolders(top, envFor(top))).parent).toBe(
      process.platform === "win32" ? "" : null,
    );
  });

  it("rejects a missing path and a file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "irix-folders-"));
    writeFileSync(path.join(root, "file.txt"), "x");
    await expect(listFolders(path.join(root, "nope"), envFor(root))).rejects.toThrow();
    await expect(listFolders(path.join(root, "file.txt"), envFor(root))).rejects.toThrow(
      /not a folder/,
    );
  });

  it("lists the drives on Windows for the empty path", async () => {
    const windows = envFor("C:\\Users\\me", {
      platform: "win32",
      exists: (candidate) => candidate === "C:\\" || candidate === "D:\\",
    });
    const listing = await listFolders("", windows);
    expect(listing.path).toBe("");
    expect(listing.parent).toBeNull();
    expect(listing.folders.map((folder) => folder.path)).toEqual(["C:\\", "D:\\"]);
  });
});

describe("shortcutsFor", () => {
  it("keeps places that exist, once each, and finds OneDrive from the environment", () => {
    const existing = new Set(["C:\\Users\\me", "C:\\Users\\me\\Desktop", "D:\\Cloud"]);
    const shortcuts = shortcutsFor({
      platform: "win32",
      home: "C:\\Users\\me",
      env: { OneDrive: "D:\\Cloud", OneDriveCommercial: "D:\\Cloud" },
      exists: (candidate) => existing.has(candidate),
    });
    expect(shortcuts).toEqual([
      { label: "Home", path: "C:\\Users\\me" },
      { label: "Desktop", path: "C:\\Users\\me\\Desktop" },
      { label: "OneDrive", path: "D:\\Cloud" },
    ]);
  });
});

describe("createFolder", () => {
  it("makes the folder and returns its path", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "irix-new-"));
    const made = await createFolder(root, "  fresh ");
    expect(made.path).toBe(path.join(root, "fresh"));
    expect((await listFolders(root, envFor(root))).folders.map((f) => f.name)).toEqual(["fresh"]);
  });

  it("refuses a name that exists, and one that is not a plain name", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "irix-new-"));
    await createFolder(root, "once");
    await expect(createFolder(root, "once")).rejects.toThrow(/already exists/);
    await expect(createFolder(root, "../escape")).rejects.toThrow();
  });
});

describe("folderNameProblem", () => {
  it("accepts ordinary names, including Chinese ones", () => {
    expect(folderNameProblem("my project")).toBeNull();
    expect(folderNameProblem("新项目")).toBeNull();
  });

  it("rejects names Windows would", () => {
    for (const bad of ["", "  ", "..", "a/b", "a\\b", "a:b", "x.", "CON", "nul.txt"]) {
      expect(folderNameProblem(bad), bad).not.toBeNull();
    }
  });
});
