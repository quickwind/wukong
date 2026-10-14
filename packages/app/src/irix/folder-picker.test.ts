import { describe, expect, it } from "vitest";

import {
  breadcrumbsOf,
  listFolders,
  pickFolderInDialog,
  settleFolderPick,
  type FolderPickerClient,
} from "./folder-picker";

const listing = { path: "C:\\work", parent: "C:\\", folders: [], shortcuts: [] };

describe("listFolders", () => {
  it("asks the plugin for one folder and validates the answer", async () => {
    const calls: unknown[][] = [];
    const client: FolderPickerClient = {
      invokePluginRpc: async (...args) => {
        calls.push(args);
        return listing;
      },
    };
    expect(await listFolders(client, "C:\\work")).toEqual(listing);
    expect(await listFolders(client)).toEqual(listing);
    expect(calls).toEqual([
      ["irix-gitlab", "irix.fs.list-folders", { path: "C:\\work" }],
      ["irix-gitlab", "irix.fs.list-folders", {}],
    ]);
  });

  it("rejects an answer of the wrong shape", async () => {
    const client: FolderPickerClient = { invokePluginRpc: async () => ({ nope: true }) };
    await expect(listFolders(client)).rejects.toThrow();
  });
});

describe("pickFolderInDialog", () => {
  const client: FolderPickerClient = { invokePluginRpc: async () => listing };

  it("resolves with the folder the dialog settles on", async () => {
    const result = pickFolderInDialog(client);
    settleFolderPick("C:\\work\\app");
    expect(await result).toBe("C:\\work\\app");
  });

  it("resolves null on cancel, and a second request cancels the first", async () => {
    const first = pickFolderInDialog(client);
    const second = pickFolderInDialog(client);
    expect(await first).toBeNull();
    settleFolderPick(null);
    expect(await second).toBeNull();
  });

  it("fails without a connection", async () => {
    await expect(pickFolderInDialog(null)).rejects.toThrow(/Not connected/);
  });
});

describe("breadcrumbsOf", () => {
  it("walks a Windows path down from the drive list", () => {
    expect(breadcrumbsOf("C:\\Users\\me")).toEqual([
      { label: "This PC", path: "" },
      { label: "C:", path: "C:\\" },
      { label: "Users", path: "C:\\Users" },
      { label: "me", path: "C:\\Users\\me" },
    ]);
    expect(breadcrumbsOf("")).toEqual([{ label: "This PC", path: "" }]);
  });

  it("walks a posix path down from the root", () => {
    expect(breadcrumbsOf("/home/me")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "me", path: "/home/me" },
    ]);
  });
});
