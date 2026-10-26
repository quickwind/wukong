import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "./level.js";
import { preferencesSchema } from "./preferences.js";

describe("preferencesSchema", () => {
  it("defaults to a warning at 50% and a critical level at 75%", () => {
    expect(preferencesSchema.parse({})).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES).toEqual({ enabled: true, warnPercent: 50, criticalPercent: 75 });
  });

  it("rejects a warning threshold at or above the critical one", () => {
    expect(preferencesSchema.safeParse({ warnPercent: 80, criticalPercent: 80 }).success).toBe(
      false,
    );
  });
});
