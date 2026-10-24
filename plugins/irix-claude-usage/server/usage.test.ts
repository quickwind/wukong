import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowedHosts,
  credentialsPath,
  discover,
  fetchUsage,
  readClaudeLogin,
  reportFromUsage,
  type ClaudeLogin,
} from "./usage.js";

const input = { store: "claude-cli" } as const;
const FUTURE = Date.parse("2026-10-24T20:51:28+11:00");
const login: ClaudeLogin = {
  accessToken: "SECRET-TOKEN",
  expiresAt: FUTURE,
  subscriptionType: "enterprise",
  rateLimitTier: "default_claude_zero",
};
const NOW = Date.parse("2026-10-24T02:15:00Z");

// The shape the real enterprise account returned (windows null, a monthly spend cap set).
const realUsage = {
  five_hour: null,
  seven_day: null,
  seven_day_opus: null,
  extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 0.0 },
  limits: [],
  spend: {
    used: { amount_minor: 0, currency: "USD", exponent: 2 },
    limit: { amount_minor: 10000, currency: "USD", exponent: 2 },
    percent: 0,
    severity: "normal",
    enabled: true,
  },
  member_dashboard_available: true,
};

function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

function available(report: ReturnType<typeof reportFromUsage>) {
  if (report.status !== "available") throw new Error(`expected available, got ${report.status}`);
  return report;
}

const spendOf = (used: number, limit: number, percent: number) => ({
  ...realUsage,
  spend: {
    ...realUsage.spend,
    used: { amount_minor: used, currency: "USD", exponent: 2 },
    limit: { amount_minor: limit, currency: "USD", exponent: 2 },
    percent,
  },
});

describe("reportFromUsage", () => {
  it("turns the monthly spend cap into a window, a balance and a detail", () => {
    const report = available(reportFromUsage(spendOf(2550, 10000, 25.5), login));
    expect(report.planLabel).toBe("Enterprise zero");
    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "spend",
        label: "Monthly spend",
        summary: true,
        usedPct: 25.5,
        remainingPct: 74.5,
      }),
    ]);
    expect(report.balances).toEqual([
      expect.objectContaining({
        id: "spend",
        unit: "usd",
        used: 25.5,
        limit: 100,
        remaining: 74.5,
      }),
    ]);
    expect(report.details).toContainEqual(
      expect.objectContaining({ id: "spend", label: "Spend", value: "$25.50 / $100.00" }),
    );
  });

  it("shows $0 of a $100 cap as an empty bar, not as missing data", () => {
    const report = available(reportFromUsage(realUsage, login));
    expect(report.windows[0]).toMatchObject({ usedPct: 0, remainingPct: 100 });
    expect(report.details).toContainEqual(expect.objectContaining({ value: "$0.00 / $100.00" }));
  });

  it("warns at 80 percent and flags danger at 95 percent", () => {
    expect(available(reportFromUsage(spendOf(8000, 10000, 80), login)).windows[0]?.tone).toBe(
      "warning",
    );
    expect(available(reportFromUsage(spendOf(9500, 10000, 95), login)).windows[0]?.tone).toBe(
      "danger",
    );
    expect(available(reportFromUsage(spendOf(7999, 10000, 79.99), login)).windows[0]?.tone).toBe(
      undefined,
    );
  });

  it("keeps the 5 hour and weekly windows when an account has them", () => {
    const report = available(
      reportFromUsage(
        {
          ...realUsage,
          five_hour: { utilization: 12, resets_at: "2026-10-24T05:00:00Z" },
          seven_day: { utilization: 40.5, resets_at: "2026-10-30T00:00:00Z" },
        },
        login,
      ),
    );
    expect(report.windows.map((window) => window.id)).toEqual(["five_hour", "weekly", "spend"]);
    expect(report.windows[0]).toMatchObject({
      label: "Session",
      shortLabel: "5h",
      usedPct: 12,
      remainingPct: 88,
      resetsAt: "2026-10-24T05:00:00Z",
    });
    expect(report.windows[1]).toMatchObject({ label: "Weekly", shortLabel: "wk", usedPct: 40.5 });
  });

  it("reports an account with no windows and no spend cap as having no quota", () => {
    const report = reportFromUsage({ five_hour: null, seven_day: null, limits: [] }, login);
    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: expect.stringContaining("no usage limit") },
    });
  });

  it("does not claim a cap when spend is disabled", () => {
    const report = reportFromUsage(
      { ...realUsage, spend: { ...realUsage.spend, enabled: false } },
      login,
    );
    expect(report.status).toBe("unavailable");
  });

  it("treats a zero cap as fully used, not as unlimited", () => {
    const report = available(reportFromUsage(spendOf(0, 0, 0), login));
    expect(report.windows[0]).toMatchObject({ usedPct: 100, remainingPct: 0, tone: "danger" });
  });

  it("honours the currency exponent", () => {
    const body = {
      ...realUsage,
      spend: {
        ...realUsage.spend,
        used: { amount_minor: 5, currency: "JPY", exponent: 0 },
        limit: { amount_minor: 100, currency: "JPY", exponent: 0 },
        percent: 5,
      },
    };
    const report = available(reportFromUsage(body, login));
    expect(report.details).toContainEqual(expect.objectContaining({ value: "5 JPY / 100 JPY" }));
  });

  it("fails loudly when the response has a shape we do not know", () => {
    expect(() => reportFromUsage("nope", login)).toThrow(/API may have changed/);
  });

  it("leaves the plan label out when the login does not say", () => {
    const report = available(reportFromUsage(realUsage, { accessToken: "t" }));
    expect(report.planLabel).toBeUndefined();
  });
});

describe("fetchUsage", () => {
  const deps = (fetchApi: typeof fetch, readLogin = async () => login) => ({
    fetchApi,
    readLogin,
    now: () => NOW,
  });

  it("asks api.anthropic.com for usage with the stored token and nothing else", async () => {
    const fetchApi = respond(realUsage);
    const report = await fetchUsage(input, deps(fetchApi));
    expect(report.status).toBe("available");
    const [url, init] = vi.mocked(fetchApi).mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer SECRET-TOKEN",
      "anthropic-beta": "oauth-2025-04-20",
    });
    expect(vi.mocked(fetchApi)).toHaveBeenCalledTimes(1);
  });

  it("asks for sign-in when the Claude CLI has no login", async () => {
    await expect(
      fetchUsage(
        input,
        deps(respond({}), async () => null),
      ),
    ).rejects.toThrow(/not signed in/);
  });

  it("reports an expired token without calling the API or refreshing it", async () => {
    const fetchApi = respond(realUsage);
    const report = await fetchUsage(
      input,
      deps(fetchApi, async () => ({ ...login, expiresAt: NOW - 1 })),
    );
    expect(report).toEqual({
      status: "unavailable",
      problem: {
        kind: "expired",
        expiresAt: new Date(NOW - 1).toISOString(),
        refreshedBy: "claude",
      },
    });
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("reports a rejected token as unavailable", async () => {
    for (const status of [401, 403]) {
      expect(await fetchUsage(input, deps(respond({}, status)))).toEqual({
        status: "unavailable",
        problem: { kind: "rejected", status, refreshedBy: "claude" },
      });
    }
  });

  it("throws on other HTTP errors without echoing the token", async () => {
    await expect(fetchUsage(input, deps(respond({}, 500)))).rejects.toThrow(
      "Claude usage API returned 500",
    );
  });

  it("says how long to wait after a 429 and does not call again until then", async () => {
    const fetchApi = vi.fn(
      async () => new Response("{}", { status: 429, headers: { "retry-after": "600" } }),
    ) as unknown as typeof fetch;
    const token = { ...login, accessToken: "RATE-LIMITED-TOKEN" };
    const run = () =>
      fetchUsage(
        input,
        deps(fetchApi, async () => token),
      );
    await expect(run()).rejects.toThrow(/Rate limited by Claude\. Try again in 10m/);
    await expect(run()).rejects.toThrow(/Rate limited by Claude/);
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it("explains a network failure with the host and a certificate hint", async () => {
    const fetchApi = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" },
      });
    }) as unknown as typeof fetch;
    await expect(fetchUsage(input, deps(fetchApi))).rejects.toThrow(
      /Could not reach api\.anthropic\.com: SELF_SIGNED_CERT_IN_CHAIN.*NODE_EXTRA_CA_CERTS/,
    );
  });
});

describe("allowedHosts", () => {
  it("is exactly api.anthropic.com", () => {
    expect([...allowedHosts()]).toEqual(["api.anthropic.com"]);
  });
});

describe("credentials", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const claudeHome = (contents?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "irix-claude-usage-"));
    dirs.push(dir);
    if (contents !== undefined) writeFileSync(join(dir, ".credentials.json"), contents);
    return dir;
  };

  it("reads the token and plan from the Claude CLI's credentials file", async () => {
    const dir = claudeHome(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok",
          expiresAt: 123,
          refreshToken: "never-read",
          subscriptionType: "enterprise",
          rateLimitTier: "default_claude_zero",
        },
      }),
    );
    expect(await readClaudeLogin(join(dir, ".credentials.json"))).toEqual({
      accessToken: "tok",
      expiresAt: 123,
      subscriptionType: "enterprise",
      rateLimitTier: "default_claude_zero",
    });
  });

  it("returns null for a missing, unreadable or token-less file", async () => {
    expect(await readClaudeLogin(join(claudeHome(), ".credentials.json"))).toBeNull();
    expect(await readClaudeLogin(join(claudeHome("not json"), ".credentials.json"))).toBeNull();
    expect(await readClaudeLogin(join(claudeHome("{}"), ".credentials.json"))).toBeNull();
  });

  it("follows CLAUDE_CONFIG_DIR, then the home directory", () => {
    expect(credentialsPath({ CLAUDE_CONFIG_DIR: "/x/claude" })).toBe(
      join("/x/claude", ".credentials.json"),
    );
    expect(credentialsPath({})).toMatch(/\.claude[\\/]\.credentials\.json$/);
  });
});

describe("discover", () => {
  const signedIn = async () => login;
  const signedOut = async () => null;

  it("offers one account when the Claude CLI is signed in", async () => {
    expect(await discover({ kind: "global" }, signedIn)).toEqual([
      { key: "default", label: "Claude CLI", harness: "Claude", input },
    ]);
  });

  it("offers nothing when signed out", async () => {
    expect(await discover({ kind: "global" }, signedOut)).toEqual([]);
  });

  it("only matches Claude sessions", async () => {
    const session = (provider: string) =>
      ({ kind: "session", provider, env: {} }) as unknown as Parameters<typeof discover>[0];
    expect(await discover(session("claude"), signedIn)).toHaveLength(1);
    expect(await discover(session("devin"), signedIn)).toEqual([]);
  });

  it("offers nothing to a Claude session that talks to a different endpoint", async () => {
    const session = (env: Record<string, string>) =>
      ({ kind: "session", provider: "claude", env }) as unknown as Parameters<typeof discover>[0];
    for (const env of [
      { ANTHROPIC_BASE_URL: "https://gateway.corp.example" },
      { CLAUDE_CODE_USE_BEDROCK: "1" },
      { CLAUDE_CODE_USE_VERTEX: "true" },
    ]) {
      expect(await discover(session(env), signedIn)).toEqual([]);
    }
    expect(
      await discover(session({ ANTHROPIC_BASE_URL: "https://api.anthropic.com/" }), signedIn),
    ).toHaveLength(1);
  });
});
