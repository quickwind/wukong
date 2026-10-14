import { DEFAULT_TERMINAL_PROFILES } from "@getpaseo/protocol/terminal-profiles";
import type { TerminalProfile } from "@getpaseo/protocol/messages";

import { isIrixActive } from "./policy.js";

const IRIX_TERMINAL_PROFILES: readonly TerminalProfile[] = DEFAULT_TERMINAL_PROFILES.filter(
  (profile) => profile.id === "claude",
);

/**
 * Irix's terminal profiles are Claude Code alone, whatever the config file says. The app
 * falls back to upstream's defaults (Codex, OpenCode, Pi) only when none are configured, so
 * the daemon always supplies this list.
 */
export function irixTerminalProfiles(
  configured: TerminalProfile[] | undefined,
): TerminalProfile[] | undefined {
  return isIrixActive() ? [...IRIX_TERMINAL_PROFILES] : configured;
}

export const wukongTerminalProfiles = irixTerminalProfiles;
