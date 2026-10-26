import { describe, expect, it } from "vitest";
import {
  contextLevel,
  DEFAULT_PREFERENCES,
  levelMessage,
  pillLabel,
  usagePercent,
} from "./level.js";

const prefs = { ...DEFAULT_PREFERENCES, warnPercent: 75, criticalPercent: 90 };

describe("usagePercent", () => {
  it("rounds to a whole percent", () => {
    expect(usagePercent(150_000, 200_000)).toBe(75);
    expect(usagePercent(1, 3)).toBe(33);
  });

  it("is null when the usage is unknown or the window is not positive", () => {
    expect(usagePercent(undefined, 200_000)).toBeNull();
    expect(usagePercent(10, undefined)).toBeNull();
    expect(usagePercent(10, 0)).toBeNull();
    expect(usagePercent(-1, 100)).toBeNull();
    expect(usagePercent(Number.NaN, 100)).toBeNull();
  });
});

describe("contextLevel", () => {
  it("is none below the warn threshold", () => {
    expect(contextLevel(74, prefs)).toBe("none");
  });

  it("is warn from the warn threshold up to the critical one", () => {
    expect(contextLevel(75, prefs)).toBe("warn");
    expect(contextLevel(89, prefs)).toBe("warn");
  });

  it("is critical from the critical threshold", () => {
    expect(contextLevel(90, prefs)).toBe("critical");
    expect(contextLevel(100, prefs)).toBe("critical");
  });

  it("is none when disabled or the percent is unknown", () => {
    expect(contextLevel(95, { ...prefs, enabled: false })).toBe("none");
    expect(contextLevel(null, prefs)).toBe("none");
  });
});

describe("levelMessage", () => {
  it("names the warning level and shows the percent", () => {
    expect(levelMessage("warn", 78)).toBe("Context window is under pressure (78%)");
  });

  it("names the critical level and shows the percent", () => {
    expect(levelMessage("critical", 93)).toBe("Context window is nearly full (93%)");
  });
});

describe("pillLabel", () => {
  // The host caps a composer pill at 160px.
  it("names the level and carries the percent", () => {
    expect(pillLabel("warn", 78)).toBe("Ctx Pressure 78%");
    expect(pillLabel("critical", 93)).toBe("Ctx Nearly Full 93%");
  });
});
