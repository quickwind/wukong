import { describe, expect, it } from "vitest";

import { breadcrumbsOf } from "./breadcrumbs.js";

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
