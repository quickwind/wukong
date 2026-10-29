import type { SearchOptions } from "../shared/rpc.js";

function splitGlobs(value: string): string[] {
  return value
    .split(",")
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);
}

/** Arguments for `rg`; the process runs with `cwd` set, so the path argument is `.`. */
export function buildRgArgs(options: Omit<SearchOptions, "cwd">): string[] {
  const args = ["--json", "--hidden", "--no-require-git", "--no-config", "--crlf"];
  args.push(options.caseSensitive ? "--case-sensitive" : "--ignore-case");
  if (!options.regex) args.push("--fixed-strings");
  if (options.wholeWord) args.push("--word-regexp");
  for (const glob of splitGlobs(options.include)) args.push("-g", glob);
  for (const glob of splitGlobs(options.exclude)) {
    // An exclude the user already wrote as "!x" would become "!!x", which excludes nothing.
    const bare = glob.replace(/^!+/, "").trim();
    if (bare.length > 0) args.push("-g", `!${bare}`);
  }
  // Hidden files are searched, .git is not. Ripgrep gives the last matching glob precedence, so
  // this comes after the user's: an include of "*" would otherwise list .git again.
  args.push("-g", "!.git");
  // --regexp keeps a query that starts with "-" from being read as a flag.
  args.push("--regexp", options.query, ".");
  return args;
}

/**
 * Arguments for `rg` to report, as JSON, each match in one file with the text that replaces it.
 * ripgrep computes the replacement, so a capture group means what it means in the search.
 */
export function buildRgReplaceArgs(
  options: {
    query: string;
    caseSensitive: boolean;
    regex: boolean;
    wholeWord: boolean;
    replacement: string;
  },
  file: string,
): string[] {
  const args = ["--json", "--no-config", "--crlf"];
  args.push(options.caseSensitive ? "--case-sensitive" : "--ignore-case");
  if (!options.regex) args.push("--fixed-strings");
  if (options.wholeWord) args.push("--word-regexp");
  // Without a regex the replacement is literal; ripgrep would still expand "$1" in it.
  const replacement = options.regex
    ? options.replacement
    : options.replacement.split("$").join("$$");
  args.push(`--replace=${replacement}`);
  args.push("--regexp", options.query, "--", file);
  return args;
}
