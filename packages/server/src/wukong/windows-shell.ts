// Wukong edition: the shell Windows uses for commands that agents run and for new terminals.
// Upstream hard-codes cmd.exe for commands a provider hands over as one string (ACP
// `terminal/create`) and uses %ComSpec% for terminals, but the skills the team writes assume
// PowerShell. `WUKONG_WINDOWS_SHELL=cmd` switches back; anything else means PowerShell.

import { isWukongActive } from "./policy.js";

export type WukongWindowsShell = "powershell" | "cmd";

/** The configured Windows shell, or undefined outside the Wukong edition (upstream decides). */
export function wukongWindowsShell(
  env: NodeJS.ProcessEnv = process.env,
): WukongWindowsShell | undefined {
  if (!isWukongActive()) {
    return undefined;
  }
  return env.WUKONG_WINDOWS_SHELL?.trim().toLowerCase() === "cmd" ? "cmd" : "powershell";
}
