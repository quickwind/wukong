import { afterEach, describe, expect, it } from "vitest";

import { activateIrixPolicy } from "../policy.js";
import { assertCloneAllowed } from "./clone-policy.js";

const config = { url: "https://gitlab.corp.example", sshHost: "git.corp.example:2222" };
const getConfig = () => config;
const noConfig = () => null;

describe("assertCloneAllowed", () => {
  let deactivate: (() => void) | undefined;
  afterEach(() => deactivate?.());

  it("allows anything until Irix is active", () => {
    expect(() => assertCloneAllowed("https://github.com/o/r.git", getConfig)).not.toThrow();
  });

  it("allows the company GitLab over https and ssh only once active", () => {
    deactivate = activateIrixPolicy();

    for (const url of [
      "https://gitlab.corp.example/g/app.git",
      "git@git.corp.example:g/app.git",
      "ssh://git@git.corp.example:2222/g/app.git",
    ]) {
      expect(() => assertCloneAllowed(url, getConfig)).not.toThrow();
    }
  });

  it("refuses GitHub and every other host", () => {
    deactivate = activateIrixPolicy();
    for (const url of [
      "https://github.com/o/r.git",
      "git@github.com:o/r.git",
      "https://evil.example/g/app.git",
      "not a url",
    ]) {
      expect(() => assertCloneAllowed(url, getConfig)).toThrow(
        /only clones from gitlab.corp.example/,
      );
    }
  });

  it("explains when GitLab is not configured", () => {
    deactivate = activateIrixPolicy();
    expect(() => assertCloneAllowed("https://github.com/o/r.git", noConfig)).toThrow(
      /not configured/,
    );
  });
});
