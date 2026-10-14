import { IRIX_BUILD } from "./build";

interface SourceField<Trailing> {
  label: string;
  placeholder: string;
  trailing: Trailing;
}

/**
 * The Plugins page's install field. Irix installs from a local folder only, so it says that
 * instead of inviting npm, Git or registry sources, and drops the link to upstream's docs on them.
 */
export function pluginSourceField<Trailing>(
  upstream: SourceField<Trailing>,
): SourceField<Trailing | undefined> {
  return IRIX_BUILD
    ? {
        label: "Plugin folder",
        placeholder: "Path of a plugin folder on this machine",
        trailing: undefined,
      }
    : upstream;
}
