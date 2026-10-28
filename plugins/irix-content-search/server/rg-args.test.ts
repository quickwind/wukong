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
      ...noGit,
      "-g",
      "src/**",
      "-g",
      "*.ts",
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
      ...noGit,
      "-g",
      "!dist",
      "-g",
      "!node_modules/**",
      "--regexp",
      "foo",
      ".",
    ]);
  });

  it("excludes .git by default, before the user's globs", () => {
    const args = buildRgArgs({ ...base, include: "src/**", exclude: "dist" });
    const gitAt = args.indexOf("!.git");
    expect(gitAt).toBeGreaterThan(0);
    expect(gitAt).toBeLessThan(args.indexOf("src/**"));
    expect(gitAt).toBeLessThan(args.indexOf("!dist"));
    expect(args).toContain("--hidden");
  });

  it("does not pass --glob-case-insensitive or --max-columns", () => {
    const args = buildRgArgs({ ...base, include: "*.ts" });
    expect(args).not.toContain("--glob-case-insensitive");
    expect(args).not.toContain("--max-columns");
  });
});
