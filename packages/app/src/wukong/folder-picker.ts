import { useSyncExternalStore } from "react";
import { z } from "zod";

const PLUGIN_ID = "wukong-gitlab";
const LIST_METHOD = "wukong.fs.list-folders";

const CREATE_METHOD = "wukong.fs.create-folder";
const CreatedSchema = z.object({ path: z.string() });

const ListingSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  folders: z.array(z.object({ name: z.string(), path: z.string() })),
  shortcuts: z.array(z.object({ label: z.string(), path: z.string() })),
});

export type FolderListing = z.infer<typeof ListingSchema>;

export interface FolderPickerClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}

/** The folders inside `path` on the daemon's machine; no `path` means the home folder. */
export async function listFolders(
  client: FolderPickerClient,
  path?: string,
): Promise<FolderListing> {
  return ListingSchema.parse(
    await client.invokePluginRpc(PLUGIN_ID, LIST_METHOD, path === undefined ? {} : { path }),
  );
}

export interface Crumb {
  label: string;
  path: string;
}

/** The path as clickable steps, from the top of the disk (or the Windows drive list) down. */
export function breadcrumbsOf(path: string): Crumb[] {
  const windows = path === "" || /^[A-Za-z]:/u.test(path);
  const parts = path.split(/[\\/]/u).filter(Boolean);
  if (windows) {
    const crumbs: Crumb[] = [{ label: "This PC", path: "" }];
    let walked = "";
    for (const [index, part] of parts.entries()) {
      walked = index === 0 ? `${part}\\` : `${walked}${walked.endsWith("\\") ? "" : "\\"}${part}`;
      crumbs.push({ label: part, path: walked });
    }
    return crumbs;
  }
  const crumbs: Crumb[] = [{ label: "/", path: "/" }];
  let walked = "";
  for (const part of parts) {
    walked = `${walked}/${part}`;
    crumbs.push({ label: part, path: walked });
  }
  return crumbs;
}

/** Makes a folder named `name` inside `parent`; resolves with its path. */
export async function createFolder(
  client: FolderPickerClient,
  parent: string,
  name: string,
): Promise<string> {
  const created = CreatedSchema.parse(
    await client.invokePluginRpc(PLUGIN_ID, CREATE_METHOD, { parent, name }),
  );
  return created.path;
}

interface PendingPick {
  client: FolderPickerClient;
  resolve(path: string | null): void;
}

let pending: PendingPick | null = null;
const listeners = new Set<() => void>();

function setPending(next: PendingPick | null): void {
  pending = next;
  for (const listener of listeners) listener();
}

/**
 * Shows the folder dialog and resolves with the folder chosen, or null if it is cancelled. The
 * dialog is drawn by `FolderPickerHost`. Asking again while one is open cancels the first.
 */
export function pickFolderInDialog(client: FolderPickerClient | null): Promise<string | null> {
  if (!client) return Promise.reject(new Error("Not connected to the daemon."));
  pending?.resolve(null);
  return new Promise((resolve) => setPending({ client, resolve }));
}

export function settleFolderPick(path: string | null): void {
  const current = pending;
  if (!current) return;
  setPending(null);
  current.resolve(path);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingFolderPick(): PendingPick | null {
  return useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
}
