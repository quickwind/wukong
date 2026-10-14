import { afterEach, describe, expect, it } from "vitest";

import { activateIrixPolicy } from "./policy.js";
import { selfUpdateRefusal } from "./update-policy.js";

describe("selfUpdateRefusal", () => {
  let deactivate: (() => void) | undefined;
  afterEach(() => deactivate?.());

  it("allows the update until Irix is active", () => {
    expect(selfUpdateRefusal()).toBeNull();
  });

  it("refuses it once Irix is active, and says to install the bundle by hand", () => {
    deactivate = activateIrixPolicy();
    expect(selfUpdateRefusal()).toMatch(/by hand/);
  });
});
