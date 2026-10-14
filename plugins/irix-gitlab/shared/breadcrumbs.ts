export interface Crumb {
  label: string;
  path: string;
}

/**
 * The path as clickable steps, from the top of the disk (or the Windows drive list) down. The app
 * has its own copy (`packages/app/src/irix/folder-picker.ts`): a plugin cannot import app code.
 */
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
