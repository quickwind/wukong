import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const SearchOptionsSchema = z.object({
  cwd: z.string().min(1).max(4096),
  query: z.string().min(2).max(1000),
  caseSensitive: z.boolean(),
  regex: z.boolean(),
  wholeWord: z.boolean(),
  /** Comma-separated globs; "" means all files. */
  include: z.string().max(1000),
  exclude: z.string().max(1000),
});
export type SearchOptions = z.infer<typeof SearchOptionsSchema>;

export const MatchSchema = z.object({
  /** Relative to cwd, forward slashes. */
  path: z.string(),
  /** 1-based. */
  line: z.number().int().positive(),
  /** 1-based UTF-16 column of the first match, in the original line. */
  column: z.number().int().positive(),
  /** The trimmed line. */
  text: z.string(),
  /** UTF-16 offsets into `text`. */
  ranges: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
  /** The file's modification time and size when the search found it; replace compares them. */
  mtimeMs: z.number().optional(),
  size: z.number().int().optional(),
});
export type Match = z.infer<typeof MatchSchema>;

// A search can outlast the 30 seconds the daemon allows one plugin RPC, so one call starts it and
// short polls collect the results.
export const startSearchRpc = defineRpc({
  name: "irix.search.content.start",
  input: SearchOptionsSchema,
  output: z.object({ id: z.string() }),
});

export const pollSearchRpc = defineRpc({
  name: "irix.search.content.poll",
  input: z.object({ id: z.string(), cursor: z.number().int().min(0) }),
  output: z.object({
    batch: z.array(MatchSchema),
    cursor: z.number().int(),
    done: z.boolean(),
    truncated: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const cancelSearchRpc = defineRpc({
  name: "irix.search.content.cancel",
  input: z.object({ id: z.string() }),
  output: z.object({}),
});

export const ReplaceFileSchema = z.object({
  /** As in a match: relative to cwd, forward slashes. */
  path: z.string().min(1).max(4096),
  mtimeMs: z.number(),
  size: z.number().int().min(0),
  /** The lines (1-based) of this file to replace; every match on them is replaced. */
  lines: z.array(z.number().int().positive()).min(1).max(100_000),
});
export type ReplaceFile = z.infer<typeof ReplaceFileSchema>;

export const ReplaceInputSchema = z.object({
  cwd: z.string().min(1).max(4096),
  /** The query and toggles the matches were found with. */
  query: z.string().min(2).max(1000),
  caseSensitive: z.boolean(),
  regex: z.boolean(),
  wholeWord: z.boolean(),
  /** In regex mode `$1` style groups apply (ripgrep's syntax); otherwise it is literal text. */
  replacement: z.string().max(10_000),
  files: z.array(ReplaceFileSchema).min(1).max(1000),
});
export type ReplaceInput = z.infer<typeof ReplaceInputSchema>;

export const ReplaceFileResultSchema = z.object({
  path: z.string(),
  status: z.enum(["replaced", "skipped"]),
  /** Matches replaced (0 when skipped). */
  count: z.number().int(),
  /** Why a file was skipped, in words for the user. */
  reason: z.string().nullable(),
});
export type ReplaceFileResult = z.infer<typeof ReplaceFileResultSchema>;

// Replace is quick (one ripgrep run per file), so it is one call.
export const replaceRpc = defineRpc({
  name: "irix.search.content.replace",
  input: ReplaceInputSchema,
  output: z.object({ results: z.array(ReplaceFileResultSchema) }),
});
