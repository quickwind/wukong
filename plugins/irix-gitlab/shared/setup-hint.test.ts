import { describe, expect, it } from "vitest";
import { needsGitLabSetup } from "./setup-hint.js";

describe("needsGitLabSetup", () => {
  it.each([
    'GitLab is not configured. Set "gitlab.url" in irix.json in the Paseo home, or IRIX_GITLAB_URL.',
    "`gitlab` not found; install python-gitlab: uv tool install python-gitlab",
    "Impossible to list (401: 401 Unauthorized)",
    "Config file not found",
  ])("points %j at the setup screen", (message) => {
    expect(needsGitLabSetup(message)).toBe(true);
  });

  it.each(["Request timed out", "Impossible to list (500: Internal Server Error)", ""])(
    "leaves %j alone",
    (message) => {
      expect(needsGitLabSetup(message)).toBe(false);
    },
  );
});
