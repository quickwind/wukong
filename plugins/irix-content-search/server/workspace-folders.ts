import path from "node:path";

/** True when `cwd` is one of `folders` or inside one. Windows compares without letter case. */
export function isWithinFolders(
  cwd: string,
  folders: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const fold = (p: string) =>
    platform === "win32" ? paths.resolve(p).toLowerCase() : paths.resolve(p);
  const target = fold(cwd);
  return folders.some((folder) => {
    const relative = paths.relative(fold(folder), target);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
    );
  });
}
