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
  name: "irix.gitlab.search",
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
  name: "irix.gitlab.clone.start",
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
  name: "irix.gitlab.clone.poll",
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
  name: "irix.pick-folder.start",
  input: z.object({ title: z.string().max(200).optional() }),
  output: z.object({ id: z.string() }),
});

export const pollPickFolderRpc = defineRpc({
  name: "irix.pick-folder.poll",
  input: z.object({ id: z.string() }),
  output: z.object({
    state: z.enum(["pending", "done", "failed"]),
    /** The chosen folder when `done`; `null` if the user cancelled. */
    path: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const FolderShortcutSchema = z.object({ label: z.string(), path: z.string() });

export const FolderListingSchema = z.object({
  /** The folder listed; empty when the Windows drive list is shown. */
  path: z.string(),
  /** The folder above, or `null` at the top (a Windows drive list, or `/`). */
  parent: z.string().nullable(),
  folders: z.array(z.object({ name: z.string(), path: z.string() })),
  shortcuts: z.array(FolderShortcutSchema),
});

export type FolderListing = z.infer<typeof FolderListingSchema>;

/**
 * Lists the folders inside one folder on the machine the daemon runs on, for the Open folder
 * screen. A browser cannot report a folder's real path, so the screen browses the disk through
 * the daemon instead. On Windows the empty path lists the drives.
 */
export const listFoldersRpc = defineRpc({
  name: "irix.fs.list-folders",
  /** Omit `path` to start in the home folder. */
  input: z.object({ path: z.string().max(4096).optional() }),
  output: FolderListingSchema,
});

export const createFolderRpc = defineRpc({
  name: "irix.fs.create-folder",
  input: z.object({ parent: z.string().min(1).max(4096), name: z.string().min(1).max(255) }),
  output: z.object({ path: z.string() }),
});

export const devinDesktopStatusRpc = defineRpc({
  name: "irix.devin-desktop.status",
  input: z.object({}),
  output: z.object({
    installed: z.boolean(),
    iconDataUrl: z.string().nullable(),
  }),
});

export const openInDevinDesktopRpc = defineRpc({
  name: "irix.devin-desktop.open",
  input: z.object({
    workspacePath: z.string().min(1).max(4096),
  }),
  output: z.object({
    ok: z.literal(true),
  }),
});

export const openInFileManagerRpc = defineRpc({
  name: "irix.file-manager.open",
  input: z.object({
    workspacePath: z.string().min(1).max(4096),
  }),
  output: z.object({
    ok: z.literal(true),
  }),
});

// GitLab setup screen (Settings > Plugins > GitLab). The token in `setupCreateSectionRpc` is the
// only secret that crosses an RPC: it is tested, written to the python-gitlab config and dropped.
export const SETUP_OVERRIDE_VARIABLES = [
  "IRIX_GITLAB_URL",
  "IRIX_GITLAB_SECTION",
  "IRIX_GITLAB_COMMAND",
  "IRIX_CLONE_ROOT",
] as const;

export const setupStatusRpc = defineRpc({
  name: "irix.gitlab.setup.status",
  input: z.object({}),
  output: z.object({
    tools: z.object({
      gitlab: z.object({ found: z.boolean(), version: z.string().nullable() }),
      uv: z.object({ found: z.boolean() }),
    }),
    cfgPath: z.string(),
    /** Sections of the python-gitlab config; `usable` is false unless the url is https. */
    sections: z.array(
      z.object({ name: z.string(), url: z.string().nullable(), usable: z.boolean() }),
    ),
    saved: z.object({
      url: z.string().nullable(),
      configSection: z.string().nullable(),
      cloneRoot: z.string().nullable(),
    }),
    /** Environment variables that are set and so win over the saved values. */
    overrides: z.array(z.enum(SETUP_OVERRIDE_VARIABLES)),
    /** Where clones go until the user picks a folder. */
    defaultCloneRoot: z.string(),
  }),
});

export const setupTestSectionRpc = defineRpc({
  name: "irix.gitlab.setup.test-section",
  input: z.object({ section: z.string().min(1).max(200) }),
  output: z.object({
    result: z.enum(["ok", "unreachable", "token-rejected"]),
    /** Why the test failed; null when it passed. */
    detail: z.string().nullable(),
    /** The token's expiry date (`YYYY-MM-DD`) when GitLab reports one. */
    expiresAt: z.string().nullable(),
    expiresSoon: z.boolean(),
    /** Scopes among api, read_repository and write_repository that the token lacks. */
    missingScopes: z.array(z.string()),
  }),
});

export const setupCreateSectionRpc = defineRpc({
  name: "irix.gitlab.setup.create-section",
  input: z.object({
    url: z.string().max(2048),
    token: z.string().max(512),
    /** Replace the token of this existing section instead of adding one; its url is kept. */
    replaceSection: z.string().max(200).optional(),
  }),
  output: z.object({ section: z.string() }),
});

export const setupSaveRpc = defineRpc({
  name: "irix.gitlab.setup.save",
  input: z.object({ section: z.string().min(1).max(200), cloneRoot: z.string().max(4096) }),
  output: z.object({
    url: z.string(),
    /** The merge-request features read irix.json once, so they need a daemon restart. */
    restartNeeded: z.boolean(),
  }),
});
