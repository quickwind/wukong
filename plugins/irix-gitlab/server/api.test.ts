import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetApis, gitlabApi, gitlabApiWithToken } from "./api.js";

const KEY = Symbol.for("irix.allowEgressHost");
const guarded = globalThis as Record<symbol, unknown>;

afterEach(() => {
  delete guarded[KEY];
  forgetApis();
});

describe("egress guard", () => {
  it("is told which GitLab host is about to be contacted", async () => {
    const allow = vi.fn();
    guarded[KEY] = allow;
    process.env.GITLAB_PRIVATE_TOKEN = "t";
    try {
      await gitlabApi({ url: "https://gitlab.corp.example/sub", section: null });
      gitlabApiWithToken("https://other.example.com", "tok");
    } finally {
      delete process.env.GITLAB_PRIVATE_TOKEN;
    }
    expect(allow.mock.calls).toEqual([["gitlab.corp.example"], ["other.example.com"]]);
  });

  it("does nothing when there is no guard, as in stock Paseo", () => {
    expect(guarded[KEY]).toBeUndefined();
    expect(() => gitlabApiWithToken("https://gitlab.corp.example", "tok")).not.toThrow();
  });
});
