import { describe, expect, it } from "vitest";

import { PLUGIN_SDK_ALIAS, createSdkAlias, toLocalSdkSpecifier } from "./plugin-sdk-alias.js";

describe("SDK alias between Paseo's name and a renamed build", () => {
  const renamed = createSdkAlias("@irix/plugin", "@getpaseo/plugin");

  it("maps the SDK and each of its entry points to the build's own name", () => {
    expect(renamed.alias).toEqual({ "@getpaseo/plugin": "@irix/plugin" });
    for (const [written, local] of [
      ["@getpaseo/plugin", "@irix/plugin"],
      ["@getpaseo/plugin/server", "@irix/plugin/server"],
      ["@getpaseo/plugin/server/provider", "@irix/plugin/server/provider"],
      ["@getpaseo/plugin/client/ui", "@irix/plugin/client/ui"],
    ]) {
      expect(renamed.toLocal(written)).toBe(local);
    }
  });

  it("leaves everything else alone, including look-alike package names", () => {
    for (const specifier of [
      "@irix/plugin/server",
      "zod",
      "react",
      "./local",
      "@getpaseo/plugins-extra",
      "@getpaseo/protocol",
      "@paseo/plugin",
    ]) {
      expect(renamed.toLocal(specifier)).toBe(specifier);
    }
  });

  it("does nothing in a source tree that was never renamed", () => {
    const same = createSdkAlias("@getpaseo/plugin", "@getpaseo/plugin");
    expect(same.alias).toEqual({});
    expect(same.toLocal("@getpaseo/plugin/server")).toBe("@getpaseo/plugin/server");
  });

  it("is the identity here, where the scope has not been renamed", () => {
    expect(PLUGIN_SDK_ALIAS).toEqual({});
    expect(toLocalSdkSpecifier("@getpaseo/plugin/client")).toBe("@getpaseo/plugin/client");
  });
});
