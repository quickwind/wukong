import { DEFAULT_TERMINAL_PROFILES, PROMPT_SENTINEL } from "@getpaseo/protocol/terminal-profiles";
import type { TerminalProfile } from "@getpaseo/protocol/messages";

import { isIrixActive } from "./policy.js";

const IRIX_TERMINAL_PROFILES: readonly TerminalProfile[] = DEFAULT_TERMINAL_PROFILES.filter(
  (profile) => profile.id === "claude",
).concat([
  // `devin [OPTIONS] [PATH]... [-- <PROMPT>...]`: the prompt must come after `--`.
  { id: "devin", name: "Devin CLI", command: "devin", args: ["--", PROMPT_SENTINEL] },
]);

/**
 * Irix's terminal profiles are Claude Code and Devin CLI alone, whatever the config file says. The app
 * falls back to upstream's defaults (Codex, OpenCode, Pi) only when none are configured, so
 * the daemon always supplies this list.
 */
export function irixTerminalProfiles(
  configured: TerminalProfile[] | undefined,
): TerminalProfile[] | undefined {
  return isIrixActive() ? [...IRIX_TERMINAL_PROFILES] : configured;
}
