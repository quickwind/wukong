export interface HintPreferences {
  enabled: boolean;
  warnPercent: number;
  criticalPercent: number;
}

export const DEFAULT_PREFERENCES: HintPreferences = {
  enabled: true,
  warnPercent: 50,
  criticalPercent: 75,
};

export type ContextLevel = "none" | "warn" | "critical";

export function usagePercent(used: number | undefined, max: number | undefined): number | null {
  if (used === undefined || max === undefined) return null;
  if (!Number.isFinite(used) || !Number.isFinite(max) || used < 0 || max <= 0) return null;
  return Math.round((used / max) * 100);
}

export function contextLevel(percent: number | null, prefs: HintPreferences): ContextLevel {
  if (!prefs.enabled || percent === null) return "none";
  if (percent >= prefs.criticalPercent) return "critical";
  if (percent >= prefs.warnPercent) return "warn";
  return "none";
}

export function levelMessage(level: Exclude<ContextLevel, "none">, percent: number): string {
  return level === "critical"
    ? `Context window is nearly full (${percent}%)`
    : `Context window is under pressure (${percent}%)`;
}

/** The pill is capped at 160px by the host, so it carries a short form of `levelMessage`. */
export function pillLabel(level: Exclude<ContextLevel, "none">, percent: number): string {
  return level === "critical" ? `Ctx Nearly Full ${percent}%` : `Ctx Pressure ${percent}%`;
}
