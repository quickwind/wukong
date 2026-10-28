import type { Match } from "./content-search";

export const MIN_QUERY_LENGTH = 2;
export const DEBOUNCE_MS = 100;
export const POLL_INTERVAL_MS = 150;

export interface FileGroup {
  path: string;
  matches: Match[];
}

export interface SearchState {
  requestKey: string;
  status: "idle" | "searching" | "done" | "error";
  groups: FileGroup[];
  matchCount: number;
  truncated: boolean;
  error: string | null;
}

export type SearchAction =
  | { type: "reset"; requestKey: string }
  | {
      type: "batch";
      requestKey: string;
      batch: Match[];
      done: boolean;
      truncated: boolean;
      /** ripgrep can exit with an error after finding matches; the matches are kept. */
      error?: string | null;
    }
  | { type: "failed"; requestKey: string; message: string };

export function shouldSearch(query: string): boolean {
  return query.trim().length >= MIN_QUERY_LENGTH;
}

export function reduceSearch(state: SearchState, action: SearchAction): SearchState {
  if (action.type === "reset") {
    return {
      requestKey: action.requestKey,
      status: "searching",
      groups: [],
      matchCount: 0,
      truncated: false,
      error: null,
    };
  }
  if (action.requestKey !== state.requestKey) return state;
  if (action.type === "failed") {
    return { ...state, status: "error", error: action.message };
  }
  const groups = state.groups.map((group) => ({ ...group }));
  const byPath = new Map(groups.map((group) => [group.path, group]));
  for (const match of action.batch) {
    let group = byPath.get(match.path);
    if (!group) {
      group = { path: match.path, matches: [] };
      byPath.set(match.path, group);
      groups.push(group);
    }
    group.matches = [...group.matches, match];
  }
  const matchCount = state.matchCount + action.batch.length;
  const error = action.done ? (action.error ?? null) : state.error;
  let status: SearchState["status"] = "searching";
  if (action.done) status = error !== null && matchCount === 0 ? "error" : "done";
  return { ...state, status, groups, matchCount, truncated: action.truncated, error };
}
