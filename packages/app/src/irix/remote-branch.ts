// Irix: a branch that lives on a remote other than `origin` (a fork checkout's `upstream`) is a row
// of its own, since `origin` may hold a branch of the same name at another commit.

import type { BranchPickerDetail, PickerItem } from "@/screens/new-workspace-picker-item";

export function otherRemoteBranchItem(detail: BranchPickerDetail): PickerItem | null {
  const remote = detail.remote;
  if (!remote || remote === "origin") {
    return null;
  }
  return {
    kind: "branch",
    name: `${detail.name} (${remote})`,
    refName: `refs/remotes/${remote}/${detail.name}`,
    accessibilityLabel: `${detail.name}, ${remote} branch`,
    committerDate: detail.committerDate,
  };
}
