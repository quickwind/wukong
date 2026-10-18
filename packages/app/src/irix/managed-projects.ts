import { IRIX_BUILD } from "./build";

/**
 * Plugins whose projects the plugin itself manages. Bot Crew keeps one workspace per bot under
 * `<home>/plugin-data/bot-crew/shared/Bots/<botId>` and draws its own sidebar tree and Bots page,
 * so the sidebar's project list and "New workspace" must not offer that project.
 *
 * This is display only. The daemon, the plugin host API and the other plugins (a work board that
 * lists workspaces and projects through `paseo.workspaces.list` / `paseo.projects.list`) still see
 * every workspace.
 */
const MANAGED_PLUGIN_IDS: readonly string[] = ["bot-crew"];

/** Windows paths come with backslashes and any letter case; compare in one form. */
function normalize(path: string): string {
  return `${path.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "")}/`;
}

export function isManagedProjectPath(path: string | null | undefined): boolean {
  if (!IRIX_BUILD || !path) return false;
  const normalized = normalize(path);
  return MANAGED_PLUGIN_IDS.some((id) => normalized.includes(`/plugin-data/${id}/`));
}

interface ProjectWithPaths {
  iconWorkingDir?: string | null;
  hosts?: readonly { iconWorkingDir?: string | null }[];
}

export function isPluginManagedProject(project: ProjectWithPaths | null | undefined): boolean {
  if (!project) return false;
  return (
    isManagedProjectPath(project.iconWorkingDir) ||
    (project.hosts ?? []).some((host) => isManagedProjectPath(host.iconWorkingDir))
  );
}

const filtered = new WeakMap<readonly object[], readonly object[]>();

/**
 * The list without the managed projects. The same array comes back when nothing is removed, and
 * the same result for the same input array, so a memo or an effect keyed on it does not re-run.
 */
export function withoutManagedProjects<Project extends ProjectWithPaths>(
  projects: Project[],
): Project[] {
  if (!IRIX_BUILD) return projects;
  const cached = filtered.get(projects);
  if (cached) return cached as Project[];
  const kept = projects.filter((project) => !isPluginManagedProject(project));
  const result = kept.length === projects.length ? projects : kept;
  filtered.set(projects, result);
  return result;
}
