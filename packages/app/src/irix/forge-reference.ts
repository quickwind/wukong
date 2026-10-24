// Irix: a fork checkout's `origin` is the user's fork, while the merge requests and issues people
// paste are in the project the fork came from. Paseo accepts a pasted link only when its path is
// the `origin` project's, so these links were ignored. Here a link to any project on the forge's
// host is accepted, and the project it names is kept so the lookup can check the item it finds
// (found by number) is in that project, not another one with the same number.

import { IRIX_BUILD } from "./build";

interface ReferencePathShape {
  kind: "issue" | "change_request";
  infix: string;
}

export interface ProjectReference {
  kind: ReferencePathShape["kind"];
  number: number;
  projectPath: string;
}

export function anyProjectReference(
  pathname: string,
  referencePath: ReferencePathShape,
): ProjectReference | null {
  if (!IRIX_BUILD) return null;
  const at = pathname.toLowerCase().indexOf(referencePath.infix);
  if (at <= 1 || !pathname.startsWith("/")) return null;
  const numberText = pathname.slice(at + referencePath.infix.length).match(/^(\d+)(?:\/|$)/u)?.[1];
  const number = numberText ? Number.parseInt(numberText, 10) : 0;
  return Number.isSafeInteger(number) && number > 0
    ? { kind: referencePath.kind, number, projectPath: pathname.slice(1, at) }
    : null;
}

/** An item with no project of its own (GitHub's) cannot be checked, so it passes. */
export function isInReferencedProject(
  item: { projectPath?: string | null },
  ref: { projectPath?: string },
): boolean {
  if (!ref.projectPath || !item.projectPath) return true;
  return item.projectPath.toLowerCase() === ref.projectPath.toLowerCase();
}
