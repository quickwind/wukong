// Devin usage for the account the Devin CLI is signed in to. Devin has no public API for a
// member's own quota; this makes the same request the CLI's /usage view makes, using the login
// the CLI stored. The key goes to an allowlisted https host and nowhere else, is never logged,
// and is not kept after the request. This plugin runs outside the daemon's egress guard, so the
// allowlist here is the only thing standing between the key and a stray host.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  unavailable,
  type UsageAccount,
  type UsageDetail,
  type UsageReport,
  type UsageScope,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import type { UsageInput } from "../shared/input.js";

const DEFAULT_HOSTS = ["server.codeium.com", "api.devin.ai"];
const STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const WARNING_PCT = 80;
const DANGER_PCT = 95;

export interface DevinLogin {
  apiKey: string;
  serverUrl: string;
}

export interface UsageDeps {
  fetchApi?: typeof fetch;
  readLogin?: () => Promise<DevinLogin | null>;
  cliVersion?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
}

/** Hosts the key may be sent to: Devin's own, plus any a company adds for its deployment. */
export function allowedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const extra = (env["IRIX_DEVIN_API_HOSTS"] ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_HOSTS, ...extra]);
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return join(
      env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"),
      "devin",
      "credentials.toml",
    );
  }
  return join(
    env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"),
    "devin",
    "credentials.toml",
  );
}

// The file is flat `key = "value"` lines; that is all this reads.
function tomlString(text: string, key: string): string | undefined {
  return text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, "m"))?.[1];
}

export async function readDevinLogin(path = credentialsPath()): Promise<DevinLogin | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const apiKey = tomlString(text, "windsurf_api_key");
  const serverUrl = tomlString(text, "api_server_url");
  return apiKey && serverUrl ? { apiKey, serverUrl } : null;
}

let cachedVersion: string | undefined;

async function devinCliVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  try {
    const { stdout } = await promisify(execFile)("devin", ["--version"], {
      timeout: 5_000,
      shell: process.platform === "win32",
    });
    const version = stdout.match(/\d+\.\d+\.\d+/)?.[0];
    if (version) cachedVersion = version;
    return version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Proto3 JSON leaves out zero values, so a missing number means zero.
const UserStatusSchema = z.object({
  userStatus: z
    .object({
      planStatus: z
        .object({
          acuConsumed: z.number().optional(),
          acuLimit: z.number().optional(),
          planInfo: z.object({ planName: z.string().optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
});

function format(acu: number): string {
  return Number.isInteger(acu) ? String(acu) : acu.toFixed(2);
}

function toneFor(usedPct: number): UsageWindow["tone"] {
  if (usedPct >= DANGER_PCT) return "danger";
  if (usedPct >= WARNING_PCT) return "warning";
  return undefined;
}

const DAY_MS = 86_400_000;
// Too early in the month, one busy day swings the average too far to call.
const MIN_FORECAST_DAYS = 3;

/** Usage resets on the first of each calendar month. `planEnd` is the contract end, not a cycle. */
export function monthBounds(now: Date): { start: number; end: number } {
  return {
    start: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    end: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  };
}

interface Weather {
  icon: string;
  word: string;
  tone: UsageWindow["tone"];
}

// Projected month-end use against the limit.
function weatherFor(ratio: number): Weather {
  if (ratio < 0.6) return { icon: "☀️", word: "plenty of room", tone: undefined };
  if (ratio < 0.85) return { icon: "🌤️", word: "on track", tone: undefined };
  if (ratio <= 1) return { icon: "⛅", word: "tight", tone: "warning" };
  if (ratio <= 1.25) return { icon: "🌧️", word: "likely over", tone: "danger" };
  return { icon: "⛈️", word: "well over", tone: "danger" };
}

function detail(id: string, label: string, value: string, tone?: UsageWindow["tone"]): UsageDetail {
  return tone ? { id, label, value, tone } : { id, label, value };
}

export interface Forecast {
  projected: number;
  ratio: number;
  weather: Weather;
  /** When the limit is reached at this month's pace; null if it is not. */
  runsOutAt: string | null;
}

/** This month's pace carried to month end. Null until there are a few days of data. */
export function forecastMonth(consumed: number, limit: number, now: Date): Forecast | null {
  const { start, end } = monthBounds(now);
  const elapsed = now.getTime() - start;
  if (elapsed < MIN_FORECAST_DAYS * DAY_MS || limit <= 0) return null;
  const rate = consumed / elapsed;
  const projected = rate * (end - start);
  const ratio = projected / limit;
  let runsOutAt: string | null = null;
  if (consumed >= limit) runsOutAt = now.toISOString();
  else if (projected > limit) {
    runsOutAt = new Date(now.getTime() + (limit - consumed) / rate).toISOString();
  }
  return { projected, ratio, weather: weatherFor(ratio), runsOutAt };
}

export function reportFromStatus(body: unknown, now: Date = new Date()): UsageReport {
  const parsed = UserStatusSchema.safeParse(body);
  const plan = parsed.success ? parsed.data.userStatus?.planStatus : undefined;
  if (!plan) throw new Error("Devin usage response has no plan status; the API may have changed");
  // A plan with no ACU figures at all is not ACU-billed. One that reports a limit of zero (or
  // omits it, as proto3 JSON does for zero) has no allowance left: fully used, not "no limit".
  if (plan.acuLimit === undefined && plan.acuConsumed === undefined) {
    return unavailable({ kind: "no_quota", detail: "This Devin plan reports no ACU limit" });
  }
  const limit = plan.acuLimit ?? 0;
  const consumed = plan.acuConsumed ?? 0;
  const usedPct = limit > 0 ? Math.min(100, (consumed / limit) * 100) : 100;
  const forecast = forecastMonth(consumed, limit, now);
  const window: UsageWindow = {
    id: "acu-period",
    label: "Monthly ACU",
    shortLabel: "ACU",
    summary: true,
    usedPct,
    remainingPct: Math.max(0, 100 - usedPct),
    resetsAt: new Date(monthBounds(now).end).toISOString(),
  };
  const tone = toneFor(usedPct);
  if (tone) window.tone = tone;
  if (forecast?.runsOutAt) {
    window.runsOutAt = forecast.runsOutAt;
    window.shortfallPct = Math.max(0, (forecast.ratio - 1) * 100);
  }
  const windows: UsageWindow[] = [window];
  const details: UsageDetail[] = [
    detail("acu", "ACU used", `${format(consumed)} / ${format(limit)}`, tone),
  ];
  if (forecast) {
    const { weather } = forecast;
    windows.push({
      id: "acu-forecast",
      label: `Month-end forecast: ${weather.word}`,
      shortLabel: weather.icon,
      summary: true,
      usedPct: Math.min(100, forecast.ratio * 100),
      ...(weather.tone ? { tone: weather.tone } : {}),
    });
    details.push(
      detail(
        "acu-forecast",
        "Forecast",
        `${weather.icon} ~${format(forecast.projected)} / ${format(limit)} by month end, ${weather.word}`,
        weather.tone,
      ),
    );
  } else if (limit > 0) {
    details.push(
      detail("acu-forecast", "Forecast", `after ${MIN_FORECAST_DAYS} days of data this month`),
    );
  }
  return {
    status: "available",
    planLabel: plan.planInfo?.planName,
    windows,
    details,
  };
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

async function requestStatus(
  fetchApi: typeof fetch,
  url: URL,
  apiKey: string,
  version: string,
): Promise<Response> {
  try {
    return await fetchApi(`${url.origin}${STATUS_PATH}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify({
        metadata: {
          apiKey,
          ideName: "devin",
          ideVersion: version,
          extensionVersion: version,
          locale: "en",
        },
      }),
    });
  } catch (error) {
    throw describeNetworkError(url.hostname, error);
  }
}

export async function fetchUsage(_input: UsageInput, deps: UsageDeps = {}): Promise<UsageReport> {
  const login = await (deps.readLogin ?? readDevinLogin)();
  if (!login) throw new Error("Devin CLI is not signed in; run `devin auth login`");
  const url = new URL(login.serverUrl);
  if (url.protocol !== "https:" || !allowedHosts(deps.env).has(url.hostname.toLowerCase())) {
    throw new Error(
      `Refusing to send the Devin login to ${url.hostname}; it is not an allowed host`,
    );
  }
  const version = await (deps.cliVersion ?? devinCliVersion)();
  const response = await requestStatus(deps.fetchApi ?? fetch, url, login.apiKey, version);
  if (response.status === 401 || response.status === 403) {
    return unavailable({ kind: "rejected", status: response.status });
  }
  if (!response.ok) throw new Error(`Devin usage API returned ${response.status}`);
  return reportFromStatus(await response.json());
}

/** One account when the CLI is signed in. A session query only matches Devin sessions. */
export async function discover(
  scope: UsageScope,
  readLogin: () => Promise<DevinLogin | null> = readDevinLogin,
): Promise<UsageAccount[]> {
  if (scope.kind === "session" && scope.provider !== "devin") return [];
  if (!(await readLogin())) return [];
  return [{ key: "default", label: "Devin CLI", harness: "Devin", input: { store: "devin-cli" } }];
}
