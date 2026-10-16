import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  pollCloneRpc,
  pollPickFolderRpc,
  createFolderRpc,
  devinDesktopStatusRpc,
  listFoldersRpc,
  openInDevinDesktopRpc,
  searchProjectsRpc,
  setupCreateSectionRpc,
  setupSaveRpc,
  setupStatusRpc,
  setupTestSectionRpc,
  startCloneRpc,
  startPickFolderRpc,
  type CloneResult,
} from "./shared/rpc.js";
import { getDevinDesktopStatus, openInDevinDesktop } from "./server/devin-desktop.js";
import { pickFolder } from "./server/pick-folder.js";
import { createFolderPickerSessions } from "./server/pick-folder-sessions.js";
import { createFolder, listFolders } from "./server/list-folders.js";
import { createJobs } from "./server/jobs.js";
import { runClone, search } from "./server/projects.js";
import {
  setupCreateSection,
  setupSave,
  setupStatus,
  setupTestSection,
} from "./server/setup/handlers.js";

// These lines land in the daemon log, so a dialog that never appears can be traced.
const folderPicker = createFolderPickerSessions(async (title) => {
  console.log(`[irix-gitlab] opening the folder dialog on ${process.platform}`);
  try {
    const path = await pickFolder(title);
    console.log(`[irix-gitlab] folder dialog closed: ${path ?? "cancelled"}`);
    return path;
  } catch (error) {
    console.error(`[irix-gitlab] folder dialog failed: ${(error as Error).message}`);
    throw error;
  }
});

const cloneJobs = createJobs<CloneResult>();

export default function contribute(server: PluginServerContext) {
  server.handle(searchProjectsRpc, search);
  server.handle(setupStatusRpc, () => setupStatus());
  server.handle(setupTestSectionRpc, (input) => setupTestSection(input));
  server.handle(setupCreateSectionRpc, (input) => setupCreateSection(input));
  server.handle(setupSaveRpc, (input) => setupSave(input));
  server.handle(listFoldersRpc, ({ path }) => listFolders(path));
  server.handle(createFolderRpc, ({ parent, name }) => createFolder(parent, name));
  server.handle(devinDesktopStatusRpc, () => getDevinDesktopStatus());
  server.handle(openInDevinDesktopRpc, ({ workspacePath }) => openInDevinDesktop(workspacePath));
  server.handle(startCloneRpc, (input) => ({
    id: cloneJobs.start((report) => runClone(input, report), "Starting…"),
  }));
  server.handle(pollCloneRpc, ({ id }) => cloneJobs.poll(id));
  server.handle(startPickFolderRpc, ({ title }) => ({ id: folderPicker.start(title) }));
  server.handle(pollPickFolderRpc, ({ id }) => folderPicker.poll(id));
  return () => {};
}
