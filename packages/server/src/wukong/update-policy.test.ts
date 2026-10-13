import { afterEach, describe, expect, it } from "vitest";

import { activateWukongPolicy } from "./policy.js";
import { selfUpdateRefusal } from "./update-policy.js";

describe("selfUpdateRefusal", () => {
  let deactivate: (() => void) | undefined;
  afterEach(() => deactivate?.());

  it("allows the update until Wukong is active", () => {
    expect(selfUpdateRefusal()).toBeNull();
  });

  it("refuses it once Wukong is active, and says to install the bundle by hand", () => {
    deactivate = activateWukongPolicy();
    expect(selfUpdateRefusal()).toMatch(/by hand/);
  });
});
