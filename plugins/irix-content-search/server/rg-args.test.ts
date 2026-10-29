import { describe, expect, it } from "vitest";
import { buildRgArgs } from "./rg-args.js";

const base = {
  query: "foo",
  caseSensitive: false,
  regex: false,
  wholeWord: false,
  include: "",
  exclude: "",
};
const always = ["--json", "--hidden", "--no-require-git", "--no-config", "--crlf"];
const noGit = ["-g", "!.git"];

describe("buildRgArgs", () => {
  it("builds a case-insensitive literal search", () => {
    expect(buildRgArgs(base)).toEqual([
      ...always,
      "--ignore-case",
      "--fixed-strings",
      ...noGit,
      "--regexp",
      "foo",
      ".",
    ]);
  });

  it("uses --case-sensitive when case sensitive", () => {
    expect(buildRgArgs({ ...base, caseSensitive: true })).toEqual([
      ...always,
      "--case-sensitive",
      "--fixed-strings",
      ...noGit,
      "--regexp",
      "foo",
      ".",
    ]);
  });

  it("omits --fixed-strings in regex mode", () => {
    expect(buildRgArgs({ ...base, regex: true, query: "a.b" })).toEqual([
      ...always,
      "--ignore-case",
      ...noGit,
      "--regexp",
      "a.b",
      ".",
    ]);
  });

  it("adds --word-regexp in both modes", () => {
    expect(buildRgArgs({ ...base, wholeWord: true })).toEqual([
      ...always,
      "--ignore-case",
      "--fixed-strings",
      "--word-regexp",
      ...noGit,
      "--regexp",
      "foo",
      ".",
    ]);
    expect(buildRgArgs({ ...base, wholeWord: true, regex: true })).toEqual([
      ...always,
      "--ignore-case",
      "--word-regexp",
      ...noGit,
      "--regexp",
      "foo",
      ".",
    ]);
  });

  it("puts a query that starts with a dash after --regexp", () => {
    expect(buildRgArgs({ ...base, query: "-foo" })).toEqual([
      ...always,
      "--ignore-case",
      "--fixed-strings",
      ...noGit,
      "--regexp",
      "-foo",
      ".",
    ]);
  });

  it("splits include globs on commas, trimming and dropping empties", () => {
    expect(buildRgArgs({ ...base, include: "src/**, *.ts,, " })).toEqual([
      ...always,
      "--ignore-case",
      "--fixed-strings",
      "-g",
      "src/**",
      "-g",
      "*.ts",
      ...noGit,
      "--regexp",
      "foo",
      ".",
    ]);
  });

  it("negates exclude globs", () => {
    expect(buildRgArgs({ ...base, exclude: "dist, node_modules/**" })).toEqual([
      ...always,
      "--ignore-case",
      "--fixed-strings",
      "-g",
      "!dist",
      "-g",
      "!node_modules/**",
      ...noGit,
      "--regexp",
      "foo",
      ".",
    ]);
  });

  it("excludes .git after the user's globs, so an include cannot bring it back", () => {
    const args = buildRgArgs({ ...base, include: "*", exclude: "dist" });
    const gitAt = args.indexOf("!.git");
    expect(args[gitAt - 1]).toBe("-g");
    expect(gitAt).toBeGreaterThan(args.indexOf("*"));
    expect(gitAt).toBeGreaterThan(args.indexOf("!dist"));
    expect(args.lastIndexOf("-g")).toBe(gitAt - 1);
    expect(args).toContain("--hidden");
  });

  it("drops the leading ! a user wrote on an exclude, and an entry that is only !", () => {
    expect(buildRgArgs({ ...base, exclude: "!dist, !!build/**, !, src" })).toEqual([
      ...always,
      "--ignore-case",
      "--fixed-strings",
      "-g",
      "!dist",
      "-g",
      "!build/**",
      "-g",
      "!src",
      ...noGit,
      "--regexp",
      "foo",
      ".",
    ]);
  });

  it("does not pass --glob-case-insensitive or --max-columns", () => {
    const args = buildRgArgs({ ...base, include: "*.ts" });
    expect(args).not.toContain("--glob-case-insensitive");
    expect(args).not.toContain("--max-columns");
  });
});
