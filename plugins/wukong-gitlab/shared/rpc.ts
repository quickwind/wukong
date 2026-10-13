import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const GitLabProjectSchema = z.object({
  path: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  webUrl: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  /** `group` for a team project, `user` for a personal one, `null` if GitLab did not say. */
  namespaceKind: z.enum(["group", "user"]).nullable(),
  /** The path of the project this one was forked from, when it is a fork. */
  forkedFrom: z.string().nullable(),
  /**
   * Whether Fork clone is offered: the project is not in the user's own namespace, whether it
   * belongs to a team or to a colleague who shared it.
   */
  canFork: z.boolean(),
});

export type GitLabProject = z.infer<typeof GitLabProjectSchema>;

export const searchProjectsRpc = defineRpc({
  name: "wukong.gitlab.search",
  input: z.object({ query: z.string(), limit: z.number().int().min(1).max(100).optional() }),
  output: z.object({
    /** Where clones go unless the user picks another folder. */
    cloneRoot: z.string(),
    projects: z.array(GitLabProjectSchema),
  }),
});

// Cloning, and forking first, take longer than the 30 seconds the daemon allows one plugin RPC, so
// the work is started by one call and its progress collected by short polls.
export const startCloneRpc = defineRpc({
  name: "wukong.gitlab.clone.start",
  input: z.object({
    /** Full project path such as `group/sub/project`. */
    path: z.string(),
    /** Folder to clone into; defaults to the configured clone root. */
    parentDirectory: z.string().optional(),
    /** Fork the project into the user's own namespace first and clone the fork. */
    fork: z.boolean().optional(),
  }),
  output: z.object({ id: z.string() }),
});

export const CloneResultSchema = z.object({
  directory: z.string(),
  alreadyCloned: z.boolean(),
  /** The project that was cloned: the fork's path when forking, otherwise the project's own. */
  clonedPath: z.string(),
  /** The original project when a fork was cloned; `upstream` points at it. */
  forkedFrom: z.string().nullable(),
});

export type CloneResult = z.infer<typeof CloneResultSchema>;

export const pollCloneRpc = defineRpc({
  name: "wukong.gitlab.clone.poll",
  input: z.object({ id: z.string() }),
  output: z.object({
    state: z.enum(["running", "done", "failed"]),
    /** Every step so far, in order; the last one is what the job is doing now. */
    steps: z.array(z.string()),
    result: CloneResultSchema.nullable(),
    error: z.string().nullable(),
  }),
});

// Choosing a folder takes longer than the 30 seconds the daemon allows one plugin RPC, so the
// dialog is started by one call and its result collected by short polls.
export const startPickFolderRpc = defineRpc({
  name: "wukong.pick-folder.start",
  input: z.object({ title: z.string().max(200).optional() }),
  output: z.object({ id: z.string() }),
});

export const pollPickFolderRpc = defineRpc({
  name: "wukong.pick-folder.poll",
  input: z.object({ id: z.string() }),
  output: z.object({
    state: z.enum(["pending", "done", "failed"]),
    /** The chosen folder when `done`; `null` if the user cancelled. */
    path: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const FolderShortcutSchema = z.object({ label: z.string(), path: z.string() });

/**
 * Lists the folders inside one folder on the machine the daemon runs on, for the Open folder
 * screen. A browser cannot report a folder's real path, so the screen browses the disk through
 * the daemon instead. On Windows the empty path lists the drives.
 */
export const listFoldersRpc = defineRpc({
  name: "wukong.fs.list-folders",
  /** Omit `path` to start in the home folder. */
  input: z.object({ path: z.string().max(4096).optional() }),
  output: z.object({
    /** The folder listed; empty when the Windows drive list is shown. */
    path: z.string(),
    /** The folder above, or `null` at the top (a Windows drive list, or `/`). */
    parent: z.string().nullable(),
    folders: z.array(z.object({ name: z.string(), path: z.string() })),
    shortcuts: z.array(FolderShortcutSchema),
  }),
});

export const createFolderRpc = defineRpc({
  name: "wukong.fs.create-folder",
  input: z.object({ parent: z.string().min(1).max(4096), name: z.string().min(1).max(255) }),
  output: z.object({ path: z.string() }),
});
