// Irix edition: the shell Windows uses for commands that agents run and for new terminals.
// Upstream hard-codes cmd.exe for commands a provider hands over as one string (ACP
// `terminal/create`) and uses %ComSpec% for terminals, but the skills the team writes assume
// PowerShell. `IRIX_WINDOWS_SHELL=cmd` switches back; anything else means PowerShell.

import { isIrixActive } from "./policy.js";

export type IrixWindowsShell = "powershell" | "cmd";

/** The configured Windows shell, or undefined outside the Irix edition (upstream decides). */
export function irixWindowsShell(
  env: NodeJS.ProcessEnv = process.env,
): IrixWindowsShell | undefined {
  if (!isIrixActive() && process.env.IRIX_EDITION_ACTIVE !== "1") {
    return undefined;
  }
  const configured = env.IRIX_WINDOWS_SHELL;
  return configured?.trim().toLowerCase() === "cmd" ? "cmd" : "powershell";
}
