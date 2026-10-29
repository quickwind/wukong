import { useEffect, useMemo, useReducer } from "react";

import {
  cancelSearch,
  pollSearch,
  startSearch,
  type ContentSearchClient,
  type SearchOptions,
} from "./content-search";
import {
  DEBOUNCE_MS,
  POLL_INTERVAL_MS,
  reduceSearch,
  shouldSearch,
  type SearchState,
} from "./content-search-state";

const UNAVAILABLE = "Search is not available on this host. Update the host.";

// What the daemon says when the plugin or one of its RPCs is missing: runtime.ts `invoke`,
// plugin-process.ts for an unknown method, and session.ts when the host has no plugin service.
const UNKNOWN_PLUGIN_OR_METHOD = [
  /^Plugin is not available: /,
  / does not contribute RPC /,
  /^Unknown RPC method: /,
  /^Plugin service is unavailable$/,
];

/** The text to show for a failed start or poll, without the daemon's request wrapping. */
export function describeSearchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name !== "DaemonRpcError") return error.message;
  const message = error.message
    .replace(/ requestType=\S+(?: code=\S+)?$/, "")
    .replace(/^Request failed: /, "");
  return UNKNOWN_PLUGIN_OR_METHOD.some((pattern) => pattern.test(message)) ? UNAVAILABLE : message;
}

const IDLE: SearchState = {
  requestKey: "",
  status: "idle",
  groups: [],
  matchCount: 0,
  truncated: false,
  error: null,
};

let nextKey = 0;

export function useContentSearch(input: {
  client: ContentSearchClient | null;
  cwd: string | null;
  options: Omit<SearchOptions, "cwd">;
}): SearchState {
  const { client, cwd } = input;
  const { query, caseSensitive, regex, wholeWord, include, exclude } = input.options;
  const [state, dispatch] = useReducer(reduceSearch, IDLE);
  const active = client !== null && cwd !== null && shouldSearch(query);

  useEffect(() => {
    if (!client || cwd === null || !shouldSearch(query)) return undefined;
    const options: SearchOptions = {
      cwd,
      query,
      caseSensitive,
      regex,
      wholeWord,
      include,
      exclude,
    };
    const requestKey = String((nextKey += 1));
    let cancelled = false;
    let id: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cancelRunning = (searchId: string) => {
      cancelSearch(client, searchId).catch(() => undefined);
    };

    const poll = async (searchId: string, cursor: number): Promise<void> => {
      const result = await pollSearch(client, searchId, cursor);
      if (cancelled) return;
      dispatch({
        type: "batch",
        requestKey,
        batch: result.batch,
        done: result.done,
        truncated: result.truncated,
        error: result.error,
      });
      if (result.done) return;
      timer = setTimeout(() => {
        poll(searchId, result.cursor).catch(fail);
      }, POLL_INTERVAL_MS);
    };

    const fail = (error: unknown) => {
      if (cancelled) return;
      dispatch({
        type: "failed",
        requestKey,
        message: describeSearchFailure(error),
      });
    };

    timer = setTimeout(() => {
      dispatch({ type: "reset", requestKey });
      const begin = async (): Promise<void> => {
        const startedId = await startSearch(client, options);
        if (cancelled) {
          cancelRunning(startedId);
          return;
        }
        id = startedId;
        await poll(startedId, 0).catch(fail);
      };
      begin().catch(fail);
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (id !== null) cancelRunning(id);
    };
  }, [client, cwd, query, caseSensitive, regex, wholeWord, include, exclude]);

  return useMemo(() => (active ? state : IDLE), [active, state]);
}
