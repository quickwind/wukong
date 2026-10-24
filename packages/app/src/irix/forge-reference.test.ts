import { afterEach, describe, expect, it, vi } from "vitest";

import { isInReferencedProject } from "./forge-reference";

describe("isInReferencedProject", () => {
  it("accepts the item of the project the link names, in any letter case", () => {
    expect(isInReferencedProject({ projectPath: "Corp/App" }, { projectPath: "corp/app" })).toBe(
      true,
    );
  });

  it("rejects an item of another project that has the same number", () => {
    expect(isInReferencedProject({ projectPath: "me/app" }, { projectPath: "corp/app" })).toBe(
      false,
    );
  });

  it("does not check a link to the checkout's own project, or an item with no project", () => {
    expect(isInReferencedProject({ projectPath: "me/app" }, {})).toBe(true);
    expect(isInReferencedProject({}, { projectPath: "corp/app" })).toBe(true);
  });
});

describe("anyProjectReference", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load() {
    vi.resetModules();
    return import("./forge-reference");
  }

  it("reads the project and number from a merge request link in an Irix build", async () => {
    vi.stubEnv("EXPO_PUBLIC_IRIX", "1");
    const { anyProjectReference } = await load();
    expect(
      anyProjectReference("/corp/group/app/-/merge_requests/42/diffs", {
        kind: "change_request",
        infix: "/-/merge_requests/",
      }),
    ).toEqual({ kind: "change_request", number: 42, projectPath: "corp/group/app" });
    expect(
      anyProjectReference("/corp/app/-/merge_requests/x", {
        kind: "change_request",
        infix: "/-/merge_requests/",
      }),
    ).toBeNull();
  });

  it("reads nothing in Paseo's own build", async () => {
    const { anyProjectReference } = await load();
    expect(
      anyProjectReference("/corp/app/-/merge_requests/42", {
        kind: "change_request",
        infix: "/-/merge_requests/",
      }),
    ).toBeNull();
  });
});
