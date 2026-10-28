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

describe("buildRgArgs", () => {
  it("builds a case-insensitive literal search", () => {
    expect(buildRgArgs(base)).toEqual([
      ...always,
      "--ignore-case",
      "--fixed-strings",
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
      "--regexp",
      "foo",
      ".",
    ]);
  });

  it("omits --fixed-strings in regex mode", () => {
    expect(buildRgArgs({ ...base, regex: true, query: "a.b" })).toEqual([
      ...always,
      "--ignore-case",
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
      "--regexp",
      "foo",
      ".",
    ]);
    expect(buildRgArgs({ ...base, wholeWord: true, regex: true })).toEqual([
      ...always,
      "--ignore-case",
      "--word-regexp",
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
