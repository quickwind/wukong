// Irix: Paseo blocks a worktree made from another project's pull request until the user approves
// it, because the project's scripts (paseo.json) would run code from that project. With no script
// in the worktree there is nothing to approve, so no block and no Setup tab.

import { normalizeLifecycleCommands } from "@getpaseo/protocol/paseo-config-schema";
import { readPaseoConfig } from "../utils/worktree.js";
import { isIrixActive } from "./policy.js";

/**
 * Whether anything in `cwd` would run on its own: worktree setup or teardown commands, terminals,
 * or scripts. A paseo.json that cannot be read counts as "yes", so the block stays.
 */
export function hasWorkspaceAutomation(cwd: string): boolean {
  if (!isIrixActive()) {
    return true;
  }
  const result = readPaseoConfig(cwd);
  if (!result.ok) {
    return true;
  }
  const config = result.config;
  if (!config) {
    return false;
  }
  const worktree = config.worktree;
  return (
    normalizeLifecycleCommands(worktree?.setup).length > 0 ||
    normalizeLifecycleCommands(worktree?.teardown).length > 0 ||
    (Array.isArray(worktree?.terminals) && worktree.terminals.length > 0) ||
    Object.keys(config.scripts ?? {}).length > 0
  );
}
