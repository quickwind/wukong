import { describe, expect, it } from "vitest";

import { IRIX_HOST_CAPS_ENV, irixHostCaps, irixHostCapsEnvValue } from "./host-caps.js";

describe("Irix host capabilities", () => {
  it("say Devin gets the system prompt and additional directories", () => {
    expect(irixHostCaps()).toEqual({
      devinSystemPrompt: true,
      devinAdditionalDirectories: true,
    });
  });

  it("travel to plugin processes as JSON in an environment variable", () => {
    expect(IRIX_HOST_CAPS_ENV).toBe("IRIX_HOST_CAPS");
    expect(JSON.parse(irixHostCapsEnvValue())).toEqual(irixHostCaps());
  });
});
