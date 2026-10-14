import { describe, expect, it, vi } from "vitest";

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { buildGitLabProjectsRoute } from "./open-gitlab-projects";

describe("buildGitLabProjectsRoute", () => {
  it("points at the bundled plugin's GitLab screen on the given host", () => {
    expect(buildGitLabProjectsRoute("srv-1")).toBe(
      "/h/srv-1/plugin/irix-gitlab/surface/add-from-gitlab",
    );
  });
});
