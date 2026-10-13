import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  pollCloneRpc,
  pollPickFolderRpc,
  createFolderRpc,
  listFoldersRpc,
  searchProjectsRpc,
  startCloneRpc,
  startPickFolderRpc,
  type CloneResult,
} from "./shared/rpc.js";
import { pickFolder } from "./server/pick-folder.js";
import { createFolderPickerSessions } from "./server/pick-folder-sessions.js";
import { createFolder, listFolders } from "./server/list-folders.js";
import { createJobs } from "./server/jobs.js";
import { runClone, search } from "./server/projects.js";

// These lines land in the daemon log, so a dialog that never appears can be traced.
const folderPicker = createFolderPickerSessions(async (title) => {
  console.log(`[wukong-gitlab] opening the folder dialog on ${process.platform}`);
  try {
    const path = await pickFolder(title);
    console.log(`[wukong-gitlab] folder dialog closed: ${path ?? "cancelled"}`);
    return path;
  } catch (error) {
    console.error(`[wukong-gitlab] folder dialog failed: ${(error as Error).message}`);
    throw error;
  }
});

const cloneJobs = createJobs<CloneResult>();

export default function contribute(server: PluginServerContext) {
  server.handle(searchProjectsRpc, search);
  server.handle(listFoldersRpc, ({ path }) => listFolders(path));
  server.handle(createFolderRpc, ({ parent, name }) => createFolder(parent, name));
  server.handle(startCloneRpc, (input) => ({
    id: cloneJobs.start((report) => runClone(input, report), "Starting…"),
  }));
  server.handle(pollCloneRpc, ({ id }) => cloneJobs.poll(id));
  server.handle(startPickFolderRpc, ({ title }) => ({ id: folderPicker.start(title) }));
  server.handle(pollPickFolderRpc, ({ id }) => folderPicker.poll(id));
  return () => {};
}
