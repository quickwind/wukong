import { describe, expect, it } from "vitest";

import { buildBranchPickerItems } from "@/screens/new-workspace-picker-item";
import { otherRemoteBranchItem } from "./remote-branch";

describe("otherRemoteBranchItem", () => {
  it("makes a row of its own for a branch on upstream, next to origin's branch of the same name", () => {
    const items = buildBranchPickerItems([
      { name: "main", committerDate: 5, hasRemote: true },
      { name: "main", committerDate: 9, hasRemote: true, remote: "upstream" },
    ]);
    expect(items.map((item) => (item.kind === "branch" ? item.refName : item.kind))).toEqual([
      "refs/remotes/origin/main",
      "refs/remotes/upstream/main",
    ]);
    expect(items[1]).toMatchObject({ name: "main (upstream)", committerDate: 9 });
  });

  it("leaves origin and unmarked branches to Paseo's own rows", () => {
    expect(otherRemoteBranchItem({ name: "main", committerDate: 1 })).toBeNull();
    expect(otherRemoteBranchItem({ name: "main", committerDate: 1, remote: "origin" })).toBeNull();
  });
});
