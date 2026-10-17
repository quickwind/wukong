import { afterEach, describe, expect, it, vi } from "vitest";
import appPackage from "../../package.json";
import { resolveAppVersion } from "./app-version";

afterEach(() => vi.unstubAllEnvs());

describe("resolveAppVersion", () => {
  it("is the package version in an ordinary build", () => {
    vi.stubEnv("EXPO_PUBLIC_IRIX_VERSION", "");
    expect(resolveAppVersion()).toBe(appPackage.version);
  });

  it("is the full Irix version when the build sets one, so it matches the daemon's", () => {
    vi.stubEnv("EXPO_PUBLIC_IRIX_VERSION", "0.11.2-irix.202610170101");
    expect(resolveAppVersion()).toBe("0.11.2-irix.202610170101");
  });
});
