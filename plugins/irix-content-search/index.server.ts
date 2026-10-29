import path from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { resolveRgBinary } from "./server/rg-binary.js";
import { replaceInFiles } from "./server/replace.js";
import { createSearchSessions } from "./server/search-sessions.js";
import { isWithinFolders } from "./server/workspace-folders.js";
import { cancelSearchRpc, pollSearchRpc, replaceRpc, startSearchRpc } from "./shared/rpc.js";

async function listWorkspaceFolders(context: PluginHandlerContext): Promise<string[]> {
  const folders: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await context.paseo.workspaces.list({
      includeBackground: true,
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const entry of page.entries)
      folders.push(entry.workspaceDirectory ?? entry.projectRootPath);
    const next = page.pageInfo.nextCursor;
    if (!page.pageInfo.hasMore || !next) return folders;
    cursor = next;
  }
}

export default function contribute(server: PluginServerContext) {
  // The plugin host does not tell a plugin its own folder, so the Irix daemon finds the ripgrep
  // shipped in this plugin's vendor/ folder and passes it in IRIX_RG_PATH; else PATH is used.
  const rgPath = resolveRgBinary();
  const sessions = createSearchSessions({ rgPath });

  server.handle(startSearchRpc, async (input, context) => {
    if (!path.isAbsolute(input.cwd)) throw new Error("Folder must be an absolute path");
    if (!isWithinFolders(input.cwd, await listWorkspaceFolders(context))) {
      throw new Error("Not a workspace folder");
    }
    return sessions.start(input);
  });
  server.handle(replaceRpc, async (input, context) => {
    if (!path.isAbsolute(input.cwd)) throw new Error("Folder must be an absolute path");
    if (!isWithinFolders(input.cwd, await listWorkspaceFolders(context))) {
      throw new Error("Not a workspace folder");
    }
    if (!rgPath) throw new Error("Replace is not available: ripgrep (rg) was not found.");
    return { results: await replaceInFiles(rgPath, input) };
  });
  server.handle(pollSearchRpc, (input) => sessions.poll(input.id, input.cursor));
  server.handle(cancelSearchRpc, (input) => {
    sessions.cancel(input.id);
    return {};
  });
  return () => sessions.dispose();
}
