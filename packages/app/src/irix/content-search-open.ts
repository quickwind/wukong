import { useCallback, useSyncExternalStore } from "react";

// Module scope so the open state outlives the Files pane: closing and reopening the pane (or
// switching workspaces and back) keeps the search shown where the user left it.
const openKeys = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether content search is shown for a workspace; key it `${serverId}:${workspaceId}`. */
export function useContentSearchOpen(key: string): boolean {
  const getSnapshot = useCallback(() => openKeys.has(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function toggleContentSearch(key: string): void {
  if (openKeys.has(key)) openKeys.delete(key);
  else openKeys.add(key);
  for (const listener of listeners) listener();
}
