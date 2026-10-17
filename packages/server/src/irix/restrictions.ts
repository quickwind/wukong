// Irix edition restrictions, on by default: no schedules, no agent-to-agent messages, no
// bypass ("yolo") permission modes. Undocumented on purpose. Setting IRIX_UNRESTRICTED=1 in
// the daemon's environment lifts all three; the IRIX_ALLOW_* variables lift one each.

import { isIrixActive } from "./policy.js";

export type IrixRestriction = "schedules" | "agentMessaging" | "bypassModes";

const ALLOW_VARIABLE: Record<IrixRestriction, string> = {
  schedules: "IRIX_ALLOW_SCHEDULES",
  agentMessaging: "IRIX_ALLOW_AGENT_MESSAGING",
  bypassModes: "IRIX_ALLOW_BYPASS_MODES",
};

function isOn(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function isIrixRestricted(
  restriction: IrixRestriction,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isIrixActive()) {
    return false;
  }
  return !(isOn(env.IRIX_UNRESTRICTED) || isOn(env[ALLOW_VARIABLE[restriction]]));
}

const SCHEDULE_TOOLS: ReadonlySet<string> = new Set([
  "create_schedule",
  "create_heartbeat",
  "delete_heartbeat",
  "list_schedules",
  "inspect_schedule",
  "pause_schedule",
  "resume_schedule",
  "delete_schedule",
  "update_schedule",
  "schedule_logs",
  "run_schedule_once",
]);

/** Agent tools Irix does not hand out: the schedule family and agent-to-agent send. */
export function isIrixToolBlocked(toolName: string): boolean {
  if (SCHEDULE_TOOLS.has(toolName)) {
    return isIrixRestricted("schedules");
  }
  return toolName === "send_agent_prompt" && isIrixRestricted("agentMessaging");
}

const BYPASS_MODE_PATTERN = /bypass|yolo|dangerous|skip.?perm|auto.?approve|full.?access/i;
const AUTO_ACCEPT_FEATURE_ID = "auto_accept";

// Mode ids a provider itself flagged `isUnattended`, learned from its catalog. The name pattern
// below is only a fallback for providers that do not flag their modes.
const unattendedModeIds = new Set<string>();

export function rememberIrixUnattendedModes(
  modes: ReadonlyArray<{ id: string; isUnattended?: boolean }> | undefined,
): void {
  for (const mode of modes ?? []) {
    if (mode.isUnattended === true) {
      unattendedModeIds.add(mode.id);
    }
  }
}

export function isBypassModeId(modeId: string | null | undefined): boolean {
  return (
    typeof modeId === "string" &&
    (unattendedModeIds.has(modeId) || BYPASS_MODE_PATTERN.test(modeId))
  );
}

/** A default mode id that is not a bypass mode, or undefined when the default is one. */
export function irixSafeDefaultModeId<T extends string | null | undefined>(
  modeId: T,
): T | undefined {
  return isIrixRestricted("bypassModes") && isBypassModeId(modeId) ? undefined : modeId;
}

/** For mode lists shown to the user: drops modes that skip permission prompts. */
export function withoutIrixBypassModes<T extends { id: string; isUnattended?: boolean }>(
  modes: T[] | undefined,
): T[] | undefined {
  rememberIrixUnattendedModes(modes);
  if (!modes || !isIrixRestricted("bypassModes")) {
    return modes;
  }
  return modes.filter((mode) => !isBypassModeId(mode.id) && mode.isUnattended !== true);
}

/** Wraps the ACP "Auto accept" toggle so it is only offered when bypass modes are allowed. */
export function irixFeatures<T>(autoAccept: T): T[] {
  return isIrixRestricted("bypassModes") ? [] : [autoAccept];
}

/**
 * A stored config (resume, reload) may carry a mode that was allowed when the agent was made.
 * Drop it so the agent starts in the provider's default mode instead of failing to load.
 */
export function withoutIrixBypassConfig<
  T extends { modeId?: string | null; featureValues?: Record<string, unknown> | null },
>(config: T): T {
  if (!isIrixRestricted("bypassModes")) {
    return config;
  }
  const next = { ...config };
  if (isBypassModeId(next.modeId)) {
    delete next.modeId;
  }
  if (next.featureValues?.[AUTO_ACCEPT_FEATURE_ID] === true) {
    next.featureValues = { ...next.featureValues, [AUTO_ACCEPT_FEATURE_ID]: false };
  }
  return next;
}

export function assertIrixModeAllowed(input: {
  modeId?: string | null;
  featureValues?: Record<string, unknown> | null;
}): void {
  if (!isIrixRestricted("bypassModes")) {
    return;
  }
  if (isBypassModeId(input.modeId) || input.featureValues?.[AUTO_ACCEPT_FEATURE_ID] === true) {
    throw new Error("Bypass permission modes are not available on this daemon.");
  }
}

export function assertIrixSchedulesAllowed(): void {
  if (isIrixRestricted("schedules")) {
    throw new Error("Schedules are not available on this daemon.");
  }
}

export function assertIrixAgentMessagingAllowed(sourceAgentId: string | undefined): void {
  if (sourceAgentId && isIrixRestricted("agentMessaging")) {
    throw new Error("Messages between agents are not available on this daemon.");
  }
}
