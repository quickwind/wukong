import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load(irix: boolean) {
  vi.resetModules();
  if (irix) vi.stubEnv("EXPO_PUBLIC_IRIX", "1");
  return import("./managed-projects");
}

const POSIX = "/home/me/.irix/plugin-data/bot-crew/shared/Bots";
const WINDOWS = "C:\\Users\\Me\\.irix\\plugin-data\\bot-crew\\shared\\Bots\\bot-abc";

describe("MANAGED_PROJECTS_HIDDEN", () => {
  it("is on in an Irix build, the same switch that exports the capability", async () => {
    const { MANAGED_PROJECTS_HIDDEN } = await load(true);
    expect(MANAGED_PROJECTS_HIDDEN).toBe(true);
  });
});

describe("isManagedProjectPath", () => {
  it("matches the Bot Crew folder on POSIX and on Windows, at any depth and in any case", async () => {
    const { isManagedProjectPath } = await load(true);
    expect(isManagedProjectPath(POSIX)).toBe(true);
    expect(isManagedProjectPath(`${POSIX}/bot-abc`)).toBe(true);
    expect(isManagedProjectPath(`${POSIX}/`)).toBe(true);
    expect(isManagedProjectPath(WINDOWS)).toBe(true);
    expect(isManagedProjectPath(WINDOWS.toUpperCase())).toBe(true);
    expect(isManagedProjectPath("/home/me/.irix/plugin-data/bot-crew")).toBe(true);
  });

  it("leaves other projects and other plugins' folders alone", async () => {
    const { isManagedProjectPath } = await load(true);
    expect(isManagedProjectPath("/home/me/work/app")).toBe(false);
    expect(isManagedProjectPath("/home/me/.irix/plugin-data/other/shared")).toBe(false);
    expect(isManagedProjectPath("/home/me/.irix/plugin-data/bot-crew-extra/x")).toBe(false);
    expect(isManagedProjectPath("/home/me/bot-crew/plugin-data")).toBe(false);
    expect(isManagedProjectPath("")).toBe(false);
    expect(isManagedProjectPath(null)).toBe(false);
  });

  it("does nothing outside an Irix build", async () => {
    const { isManagedProjectPath, withoutManagedProjects, MANAGED_PROJECTS_HIDDEN } =
      await load(false);
    expect(MANAGED_PROJECTS_HIDDEN).toBe(false);
    expect(isManagedProjectPath(POSIX)).toBe(false);
    const projects = [{ iconWorkingDir: POSIX, hosts: [] }];
    expect(withoutManagedProjects(projects)).toBe(projects);
  });
});

describe("withoutManagedProjects", () => {
  const bots = { iconWorkingDir: POSIX, hosts: [{ iconWorkingDir: POSIX }] };
  const app = {
    iconWorkingDir: "/home/me/work/app",
    hosts: [{ iconWorkingDir: "/home/me/work/app" }],
  };

  it("drops the managed project and keeps the order of the rest", async () => {
    const { withoutManagedProjects } = await load(true);
    const other = { iconWorkingDir: "/x", hosts: [] };
    expect(withoutManagedProjects([app, bots, other])).toEqual([app, other]);
  });

  it("also catches a project that is managed only on one of its hosts", async () => {
    const { withoutManagedProjects } = await load(true);
    const mixed = {
      iconWorkingDir: "/x",
      hosts: [{ iconWorkingDir: "/x" }, { iconWorkingDir: WINDOWS }],
    };
    expect(withoutManagedProjects([app, mixed])).toEqual([app]);
  });

  it("returns the same array when nothing is removed, and the same result for the same input", async () => {
    const { withoutManagedProjects } = await load(true);
    const clean = [app];
    expect(withoutManagedProjects(clean)).toBe(clean);
    const dirty = [app, bots];
    expect(withoutManagedProjects(dirty)).toBe(withoutManagedProjects(dirty));
  });
});
