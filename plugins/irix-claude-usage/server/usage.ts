// Claude usage for the account the Claude CLI is signed in to. Upstream's claude-usage-source
// only reads the 5 hour and weekly windows, which an enterprise seat does not have; its monthly
// spend cap (`spend`) is what the account actually has, so this plugin reads that too. It makes the
// request the CLI makes for its own usage view, with the OAuth token the CLI stored. The token goes
// to api.anthropic.com and nowhere else, is never logged, is never refreshed or written back (the
// CLI owns the file), and is not kept after the request.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  unavailable,
  type UsageAccount,
  type UsageBalance,
  type UsageDetail,
  type UsageReport,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import type { UsageInput } from "../shared/input.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ALLOWED_HOSTS = ["api.anthropic.com"];
const OAUTH_BETA = "oauth-2025-04-20";
const WARNING_PCT = 80;
const DANGER_PCT = 95;

export interface ClaudeLogin {
  accessToken: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface UsageDeps {
  fetchApi?: typeof fetch;
  readLogin?: () => Promise<ClaudeLogin | null>;
  now?: () => number;
}

/** Hosts the token may be sent to. The egress guard must open the same ones (claude-hosts.test.ts). */
export function allowedHosts(): Set<string> {
  return new Set(ALLOWED_HOSTS);
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"), ".credentials.json");
}

const CredentialsSchema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string().min(1),
      expiresAt: z.number().optional(),
      subscriptionType: z.string().optional(),
      rateLimitTier: z.string().optional(),
    })
    .optional(),
});

/** Only the fields a usage request needs; the refresh token is never read out of the file. */
export async function readClaudeLogin(path = credentialsPath()): Promise<ClaudeLogin | null> {
  let parsed: z.infer<typeof CredentialsSchema>;
  try {
    parsed = CredentialsSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
  const oauth = parsed.claudeAiOauth;
  if (!oauth) return null;
  const { accessToken, expiresAt, subscriptionType, rateLimitTier } = oauth;
  return {
    accessToken,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(subscriptionType !== undefined ? { subscriptionType } : {}),
    ...(rateLimitTier !== undefined ? { rateLimitTier } : {}),
  };
}

const WindowSchema = z.object({
  utilization: z.coerce.number().finite(),
  resets_at: z.string().nullish(),
});

const MoneySchema = z.object({
  amount_minor: z.number().finite(),
  currency: z.string(),
  exponent: z.number().int().min(0),
});

const UsageResponseSchema = z.object({
  five_hour: WindowSchema.nullish(),
  seven_day: WindowSchema.nullish(),
  spend: z
    .object({ enabled: z.boolean().nullish(), used: MoneySchema, limit: MoneySchema.nullish() })
    .nullish(),
});

type UsageResponse = z.infer<typeof UsageResponseSchema>;
type Tone = UsageWindow["tone"];

function toneFor(usedPct: number): Tone {
  if (usedPct >= DANGER_PCT) return "danger";
  if (usedPct >= WARNING_PCT) return "warning";
  return undefined;
}

function planLabel(login: ClaudeLogin): string | undefined {
  if (!login.subscriptionType) return undefined;
  const label = login.subscriptionType.charAt(0).toUpperCase() + login.subscriptionType.slice(1);
  const tier = login.rateLimitTier?.split("_").pop();
  return tier ? `${label} ${tier}` : label;
}

function windowFor(
  id: string,
  label: string,
  shortLabel: string,
  usedPct: number,
  resetsAt?: string | null,
): UsageWindow {
  const clamped = Math.min(100, Math.max(0, usedPct));
  const window: UsageWindow = {
    id,
    label,
    shortLabel,
    summary: true,
    usedPct: clamped,
    remainingPct: 100 - clamped,
  };
  if (resetsAt) window.resetsAt = resetsAt;
  const tone = toneFor(clamped);
  if (tone) window.tone = tone;
  return window;
}

const major = (money: z.infer<typeof MoneySchema>): number =>
  money.amount_minor / 10 ** money.exponent;

function formatMoney(money: z.infer<typeof MoneySchema>): string {
  const text = major(money).toFixed(money.exponent);
  return money.currency === "USD" ? `$${text}` : `${text} ${money.currency}`;
}

function spendReport(spend: NonNullable<UsageResponse["spend"]>): {
  window: UsageWindow;
  balances: UsageBalance[];
  detail: UsageDetail;
} {
  const limit = spend.limit ?? { ...spend.used, amount_minor: 0 };
  const used = major(spend.used);
  const cap = major(limit);
  // A cap of zero leaves no allowance: fully used, not "no limit".
  const usedPct = cap > 0 ? (used / cap) * 100 : 100;
  const window = windowFor("spend", "Monthly spend", "$", usedPct);
  const balances: UsageBalance[] =
    spend.used.currency === "USD"
      ? [
          {
            id: "spend",
            label: "Monthly spend",
            used,
            limit: cap,
            remaining: Math.max(0, cap - used),
            unit: "usd",
            ...(window.tone ? { tone: window.tone } : {}),
          },
        ]
      : [];
  const detail: UsageDetail = {
    id: "spend",
    label: "Spend",
    value: `${formatMoney(spend.used)} / ${formatMoney(limit)}`,
    ...(window.tone ? { tone: window.tone } : {}),
  };
  return { window, balances, detail };
}

export function reportFromUsage(body: unknown, login: ClaudeLogin): UsageReport {
  const parsed = UsageResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("Claude usage response was not understood; the API may have changed");
  }
  const { five_hour, seven_day, spend } = parsed.data;
  const windows: UsageWindow[] = [];
  const balances: UsageBalance[] = [];
  const details: UsageDetail[] = [];
  if (five_hour) {
    windows.push(
      windowFor("five_hour", "Session", "5h", five_hour.utilization, five_hour.resets_at),
    );
  }
  if (seven_day) {
    windows.push(windowFor("weekly", "Weekly", "wk", seven_day.utilization, seven_day.resets_at));
  }
  if (spend && spend.enabled !== false) {
    const report = spendReport(spend);
    windows.push(report.window);
    balances.push(...report.balances);
    details.push(report.detail);
  }
  if (windows.length === 0) {
    return unavailable({
      kind: "no_quota",
      detail: "This Claude account reports no usage limit to show",
    });
  }
  return { status: "available", planLabel: planLabel(login), windows, balances, details };
}

// A 429 carries Retry-After, in the tens of minutes. Until it passes, a fetch (a forced Refresh
// included) answers from here instead of calling again. Keyed by the token's tail, never stored whole.
const rateLimitedUntil = new Map<string, number>();

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function rateLimitedError(waitMs: number | null): Error {
  if (waitMs === null) return new Error("Rate limited by Claude. Try again later.");
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  const wait = minutes < 60 ? `${minutes}m` : `${Math.ceil(minutes / 60)}h`;
  return new Error(`Rate limited by Claude. Try again in ${wait}.`);
}

/** Node's fetch only says "fetch failed"; the reason (certificate, DNS, refused) is in `cause`. */
function describeNetworkError(host: string, error: unknown): Error {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const reason = cause?.code ?? cause?.message ?? (error as Error).message;
  const hint =
    cause?.code && /CERT|SELF_SIGNED|ISSUER|VERIFY|SIGNATURE/.test(cause.code)
      ? " (a proxy or firewall may be re-signing HTTPS; set NODE_EXTRA_CA_CERTS to your company CA file)"
      : "";
  return new Error(`Could not reach ${host}: ${reason}${hint}`);
}

export async function fetchUsage(_input: UsageInput, deps: UsageDeps = {}): Promise<UsageReport> {
  const now = deps.now ?? Date.now;
  const login = await (deps.readLogin ?? readClaudeLogin)();
  if (!login) throw new Error("Claude CLI is not signed in; run `claude` and log in");
  if (login.expiresAt !== undefined && login.expiresAt <= now()) {
    return unavailable({
      kind: "expired",
      expiresAt: new Date(login.expiresAt).toISOString(),
      refreshedBy: "claude",
    });
  }
  const url = new URL(USAGE_URL);
  if (url.protocol !== "https:" || !allowedHosts().has(url.hostname)) {
    throw new Error(`Refusing to send the Claude login to ${url.hostname}`);
  }
  const key = login.accessToken.slice(-16);
  const limitedUntil = rateLimitedUntil.get(key);
  if (limitedUntil !== undefined && limitedUntil > now()) {
    throw rateLimitedError(limitedUntil - now());
  }
  rateLimitedUntil.delete(key);

  let response: Response;
  try {
    response = await (deps.fetchApi ?? fetch)(USAGE_URL, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${login.accessToken}`,
        Accept: "application/json",
        "anthropic-beta": OAUTH_BETA,
      },
    });
  } catch (error) {
    throw describeNetworkError(url.hostname, error);
  }
  if (response.status === 401 || response.status === 403) {
    return unavailable({ kind: "rejected", status: response.status, refreshedBy: "claude" });
  }
  if (response.status === 429) {
    const waitMs = retryAfterMs(response.headers.get("retry-after"), now());
    if (waitMs !== null) rateLimitedUntil.set(key, now() + waitMs);
    throw rateLimitedError(waitMs);
  }
  if (!response.ok) throw new Error(`Claude usage API returned ${response.status}`);
  return reportFromUsage(await response.json(), login);
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

/** One account when the CLI is signed in. A Claude session on another endpoint is not this account. */
export async function discover(
  scope: UsageScope,
  readLogin: () => Promise<ClaudeLogin | null> = readClaudeLogin,
): Promise<UsageAccount[]> {
  if (scope.kind === "session") {
    if (scope.provider !== "claude") return [];
    const env = scope.env;
    const foreign =
      env["ANTHROPIC_BASE_URL"] &&
      env["ANTHROPIC_BASE_URL"].replace(/\/+$/, "") !== "https://api.anthropic.com";
    if (
      enabled(env["CLAUDE_CODE_USE_BEDROCK"]) ||
      enabled(env["CLAUDE_CODE_USE_VERTEX"]) ||
      foreign
    ) {
      return [];
    }
  }
  if (!(await readLogin())) return [];
  return [
    { key: "default", label: "Claude CLI", harness: "Claude", input: { store: "claude-cli" } },
  ];
}
