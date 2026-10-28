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
  // Hidden files are searched, .git is not. Ripgrep gives later globs precedence, so this
  // comes before the user's.
  args.push("-g", "!.git");
  for (const glob of splitGlobs(options.include)) args.push("-g", glob);
  for (const glob of splitGlobs(options.exclude)) args.push("-g", `!${glob}`);
  // --regexp keeps a query that starts with "-" from being read as a flag.
  args.push("--regexp", options.query, ".");
  return args;
}
