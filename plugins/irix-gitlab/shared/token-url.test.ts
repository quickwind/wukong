import { describe, expect, it } from "vitest";
import { tokenPageUrl } from "./token-url.js";

describe("tokenPageUrl", () => {
  it("opens the personal access token page with the name and scopes prefilled", () => {
    expect(tokenPageUrl("https://gl.example.com")).toBe(
      "https://gl.example.com/-/user_settings/personal_access_tokens?name=Irix&description=Irix+GitLab+access&scopes=api,read_repository,write_repository",
    );
  });

  it("does not double a trailing slash and keeps a sub-path", () => {
    expect(tokenPageUrl("https://gl.example.com/gitlab//")).toMatch(
      /^https:\/\/gl\.example\.com\/gitlab\/-\/user_settings\/personal_access_tokens\?/,
    );
  });
});
