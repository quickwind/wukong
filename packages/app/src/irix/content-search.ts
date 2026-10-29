import { z } from "zod";

// The plugin bundle cannot be imported from the app, so these schemas mirror
// plugins/irix-content-search/shared/rpc.ts.
const PLUGIN_ID = "irix-content-search";
const START_METHOD = "irix.search.content.start";
const POLL_METHOD = "irix.search.content.poll";
const CANCEL_METHOD = "irix.search.content.cancel";
const REPLACE_METHOD = "irix.search.content.replace";

const MatchSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  text: z.string(),
  ranges: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
  mtimeMs: z.number().optional(),
  size: z.number().int().optional(),
});
export type Match = z.infer<typeof MatchSchema>;

const StartedSchema = z.object({ id: z.string() });

const PollResultSchema = z.object({
  batch: z.array(MatchSchema),
  cursor: z.number().int(),
  done: z.boolean(),
  truncated: z.boolean(),
  error: z.string().nullable(),
});
export type PollResult = z.infer<typeof PollResultSchema>;

export interface SearchOptions {
  cwd: string;
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  /** Comma-separated globs; "" means all files. */
  include: string;
  exclude: string;
}

export interface ContentSearchClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}

export async function startSearch(
  client: ContentSearchClient,
  options: SearchOptions,
): Promise<string> {
  return StartedSchema.parse(await client.invokePluginRpc(PLUGIN_ID, START_METHOD, options)).id;
}

export async function pollSearch(
  client: ContentSearchClient,
  id: string,
  cursor: number,
): Promise<PollResult> {
  return PollResultSchema.parse(
    await client.invokePluginRpc(PLUGIN_ID, POLL_METHOD, { id, cursor }),
  );
}

export async function cancelSearch(client: ContentSearchClient, id: string): Promise<void> {
  await client.invokePluginRpc(PLUGIN_ID, CANCEL_METHOD, { id });
}

export interface ReplaceFile {
  path: string;
  mtimeMs: number;
  size: number;
  lines: number[];
}

export interface ReplaceRequest {
  cwd: string;
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  replacement: string;
  files: ReplaceFile[];
}

const ReplaceResultSchema = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      status: z.enum(["replaced", "skipped"]),
      count: z.number().int(),
      reason: z.string().nullable(),
    }),
  ),
});
export type ReplaceResult = z.infer<typeof ReplaceResultSchema>["results"][number];

export async function replaceMatches(
  client: ContentSearchClient,
  request: ReplaceRequest,
): Promise<ReplaceResult[]> {
  return ReplaceResultSchema.parse(await client.invokePluginRpc(PLUGIN_ID, REPLACE_METHOD, request))
    .results;
}
