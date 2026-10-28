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
        message: error instanceof Error ? error.message : String(error),
      });
    };

    timer = setTimeout(() => {
      dispatch({ type: "reset", requestKey });
      const begin = async (): Promise<void> => {
        let startedId: string;
        try {
          startedId = await startSearch(client, options);
        } catch (error) {
          fail(
            error instanceof Error && error.name === "ZodError" ? error : new Error(UNAVAILABLE),
          );
          return;
        }
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
