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
