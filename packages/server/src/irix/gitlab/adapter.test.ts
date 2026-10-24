import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ForgeRegistry } from "../../services/forge-registry.js";
import { activateIrixPolicy } from "../policy.js";
import {
  createIrixGitLabAdapter,
  irixForgeEntries,
  withoutAbandonedMergeRequest,
} from "./adapter.js";
import { loadGitLabForgeConfig, parseGitLabProjectPath } from "./config.js";

const config = { url: "https://gitlab.corp.example/", sshHost: "git.corp.example:2222" };
const upstream = [["github", { createService: () => ({}) as never }]] as const;

describe("Irix GitLab forge", () => {
  let deactivate: (() => void) | undefined;
  afterEach(() => deactivate?.());

  it("keeps upstream's forges until activated, then GitLab alone", () => {
    const adapter = createIrixGitLabAdapter(() => config);
    expect(irixForgeEntries([...upstream], adapter).map(([id]) => id)).toEqual(["github"]);
    deactivate = activateIrixPolicy();
    const registry = new ForgeRegistry(irixForgeEntries([...upstream], adapter));
    expect(registry.ids()).toEqual(["gitlab"]);
  });

  it("recognises only the configured GitLab hosts", () => {
    const adapter = createIrixGitLabAdapter(() => config);
    expect(adapter.matchesHost?.("gitlab.corp.example")).toBe(true);
    expect(adapter.matchesHost?.("git.corp.example")).toBe(true);
    expect(adapter.matchesHost?.("github.com")).toBe(false);
    expect(createIrixGitLabAdapter(() => null).matchesHost?.("gitlab.corp.example")).toBe(false);
  });

  it("derives the project path from https, scp and ssh remotes only on the configured host", () => {
    expect(parseGitLabProjectPath(config, "https://gitlab.corp.example/g/s/app.git")).toBe(
      "g/s/app.git".replace(/\.git$/u, ""),
    );
    expect(parseGitLabProjectPath(config, "git@git.corp.example:g/app.git")).toBe("g/app");
    expect(parseGitLabProjectPath(config, "ssh://git@git.corp.example:2222/g/app.git")).toBe(
      "g/app",
    );
    expect(parseGitLabProjectPath(config, "git@github.com:g/app.git")).toBeNull();
  });

  it("reads irix.json, with environment variables taking precedence", () => {
    const home = mkdtempSync(join(tmpdir(), "irix-"));
    expect(loadGitLabForgeConfig(home, {})).toBeNull();
    writeFileSync(
      join(home, "irix.json"),
      JSON.stringify({ gitlab: { url: "https://file.example", configSection: "corp" } }),
    );
    expect(loadGitLabForgeConfig(home, {})).toMatchObject({ url: "https://file.example" });
    expect(loadGitLabForgeConfig(home, { IRIX_GITLAB_URL: "https://env.example" })).toMatchObject({
      url: "https://env.example",
      configSection: "corp",
    });
    expect(() => loadGitLabForgeConfig(home, { IRIX_GITLAB_URL: "http://plain.example" })).toThrow(
      /https/,
    );
  });

  it("accepts the documented file, including cloneRoot, with or without a UTF-8 BOM", () => {
    const home = mkdtempSync(join(tmpdir(), "irix-"));
    const documented = {
      gitlab: {
        url: "https://gitlab.corp.example",
        configSection: "corp",
        cloneRoot: "D:\\projects",
      },
    };
    writeFileSync(join(home, "irix.json"), JSON.stringify(documented));
    expect(loadGitLabForgeConfig(home, {})).toMatchObject({ configSection: "corp" });
    // Windows PowerShell and older Notepad write UTF-8 with a byte order mark.
    writeFileSync(join(home, "irix.json"), `\uFEFF${JSON.stringify(documented)}`);
    expect(loadGitLabForgeConfig(home, {})?.url).toBe("https://gitlab.corp.example");
  });
});

describe("withoutAbandonedMergeRequest", () => {
  it("hides a merge request that was closed without merging", () => {
    expect(withoutAbandonedMergeRequest({ state: "closed", isMerged: false })).toBeNull();
  });

  it.each([
    [{ state: "open", isMerged: false }],
    [{ state: "merged", isMerged: true }],
    // A merged request is reported as merged, not closed; if both were ever true it still shows.
    [{ state: "closed", isMerged: true }],
  ])("keeps %j", (status) => {
    expect(withoutAbandonedMergeRequest(status)).toBe(status);
  });

  it("passes through no merge request", () => {
    expect(withoutAbandonedMergeRequest(null)).toBeNull();
  });
});
