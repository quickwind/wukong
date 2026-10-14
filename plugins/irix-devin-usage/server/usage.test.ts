import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowedHosts,
  discover,
  fetchUsage,
  readDevinLogin,
  reportFromStatus,
  type DevinLogin,
} from "./usage.js";

const input = { store: "devin-cli" } as const;
const login: DevinLogin = { apiKey: "SECRET-KEY", serverUrl: "https://server.codeium.com" };

// The shape the real account returned (strings the probe masked are made up).
const realStatus = {
  userStatus: {
    planStatus: {
      planInfo: { planName: "Cognition Platform (Enterprise)", isEnterprise: true },
      planStart: "2026-10-01T00:00:00Z",
      planEnd: "2026-11-01T00:00:00Z",
      availablePromptCredits: -1,
      acuConsumed: 9.314008,
      acuLimit: 30,
    },
  },
};

function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

const deps = (fetchApi: typeof fetch, readLogin = async () => login) => ({
  fetchApi,
  readLogin,
  cliVersion: async () => "3000.6.2",
});

// Oct 10 noon UTC: 9.5 days into a 31-day month.
const NOW = new Date("2026-10-10T12:00:00Z");

function available(report: ReturnType<typeof reportFromStatus>) {
  if (report.status !== "available") throw new Error(`expected available, got ${report.status}`);
  return report;
}

const acuStatus = (acuConsumed: number | undefined, acuLimit = 30) => ({
  userStatus: { planStatus: { acuConsumed, acuLimit } },
});

describe("reportFromStatus", () => {
  it("turns ACU used and limit into a monthly window and a detail", () => {
    const report = available(reportFromStatus(realStatus, NOW));
    expect(report.planLabel).toBe("Cognition Platform (Enterprise)");
    const window = report.windows[0];
    expect(window?.label).toBe("Monthly ACU");
    expect(window?.usedPct).toBeCloseTo(31.05, 1);
    expect(window?.remainingPct).toBeCloseTo(68.95, 1);
    expect(window?.tone).toBeUndefined();
    expect(report.details?.[0]).toMatchObject({ label: "ACU used", value: "9.31 / 30" });
  });

  it("resets on the first of the next calendar month, not on the contract end", () => {
    const body = {
      userStatus: {
        planStatus: { acuConsumed: 9, acuLimit: 30, planEnd: "2027-08-01T00:00:00Z" },
      },
    };
    expect(available(reportFromStatus(body, NOW)).windows[0]?.resetsAt).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(
      available(reportFromStatus(body, new Date("2026-12-31T23:00:00Z"))).windows[0]?.resetsAt,
    ).toBe("2027-01-01T00:00:00.000Z");
    expect(
      available(reportFromStatus(body, new Date("2026-11-01T00:00:00Z"))).windows[0]?.resetsAt,
    ).toBe("2026-12-01T00:00:00.000Z");
  });

  it("warns from 80 percent and flags danger from 95", () => {
    const tone = (acu: number) => available(reportFromStatus(acuStatus(acu), NOW)).windows[0]?.tone;
    expect(tone(23.9)).toBeUndefined();
    expect(tone(24)).toBe("warning");
    expect(tone(28.4)).toBe("warning");
    expect(tone(28.5)).toBe("danger");
    expect(tone(40)).toBe("danger");
  });

  it("caps the bar at 100 percent when the account is over its limit", () => {
    const report = available(reportFromStatus(acuStatus(40), NOW));
    expect(report.windows[0]?.usedPct).toBe(100);
    expect(report.details?.[0]?.value).toBe("40 / 30");
  });

  it("treats a missing consumed value as zero, as proto3 JSON omits zeros", () => {
    const report = available(reportFromStatus(acuStatus(undefined), NOW));
    expect(report.windows[0]?.usedPct).toBe(0);
    expect(report.details?.[0]?.value).toBe("0 / 30");
  });

  it("says so when the plan has no ACU figures at all, rather than showing zero", () => {
    expect(reportFromStatus({ userStatus: { planStatus: { planInfo: {} } } }, NOW)).toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: "This Devin plan reports no ACU limit" },
    });
  });

  it("shows a limit of zero as fully used, with no forecast", () => {
    for (const planStatus of [
      { acuLimit: 0, acuConsumed: 0 },
      { acuLimit: 0 },
      { acuConsumed: 9.31 }, // proto3 JSON leaves a zero limit out
    ]) {
      const report = available(reportFromStatus({ userStatus: { planStatus } }, NOW));
      const [window] = report.windows;
      expect(report.windows).toHaveLength(1);
      expect(window?.usedPct).toBe(100);
      expect(window?.remainingPct).toBe(0);
      expect(window?.tone).toBe("danger");
      expect(window?.resetsAt).toBe("2026-11-01T00:00:00.000Z");
      expect(report.details?.map((d) => d.id)).toEqual(["acu"]);
    }
    const shown = available(
      reportFromStatus({ userStatus: { planStatus: { acuLimit: 0, acuConsumed: 9.31 } } }, NOW),
    );
    expect(shown.details?.[0]).toMatchObject({
      label: "ACU used",
      value: "9.31 / 0",
      tone: "danger",
    });
  });

  it("fails loudly when the response no longer has a plan status", () => {
    expect(() => reportFromStatus({ userStatus: {} }, NOW)).toThrow(/API may have changed/);
    expect(() => reportFromStatus("nope", NOW)).toThrow(/API may have changed/);
  });
});

describe("month-end forecast", () => {
  const weather = (acu: number, now = NOW) => {
    const report = available(reportFromStatus(acuStatus(acu), now));
    return report.windows.find((w) => w.id === "acu-forecast");
  };

  it("picks the weather from projected use against the limit", () => {
    // 9.5 days in, 31 days in the month: projected = acu * 31 / 9.5 = acu * 3.263
    expect(weather(5)?.shortLabel).toBe("☀️"); // 16.3 of 30
    expect(weather(7)?.shortLabel).toBe("🌤️"); // 22.8
    expect(weather(8.5)?.shortLabel).toBe("⛅"); // 27.7
    expect(weather(9.314008)?.shortLabel).toBe("🌧️"); // 30.4: just over
    expect(weather(13)?.shortLabel).toBe("⛈️"); // 42.4
  });

  it("colours the forecast window by how bad it looks", () => {
    expect(weather(5)?.tone).toBeUndefined();
    expect(weather(8.5)?.tone).toBe("warning");
    expect(weather(13)?.tone).toBe("danger");
  });

  it("shows the projected figure in the details", () => {
    const report = available(reportFromStatus(acuStatus(9.314008), NOW));
    const detail = report.details?.find((d) => d.id === "acu-forecast");
    expect(detail?.value).toBe("🌧️ ~30.39 / 30 by month end, likely over");
    expect(detail?.tone).toBe("danger");
  });

  it("marks when the limit runs out, using the app's own at-risk fields, only if it will", () => {
    const over = available(reportFromStatus(acuStatus(9.314008), NOW)).windows[0];
    expect(over?.runsOutAt).toBeDefined();
    expect(Date.parse(over?.runsOutAt ?? "")).toBeGreaterThan(NOW.getTime());
    expect(Date.parse(over?.runsOutAt ?? "")).toBeLessThan(Date.parse("2026-11-01T00:00:00Z"));
    expect(over?.shortfallPct).toBeCloseTo(1.3, 1);
    const fine = available(reportFromStatus(acuStatus(5), NOW)).windows[0];
    expect(fine?.runsOutAt).toBeUndefined();
    expect(fine?.shortfallPct).toBeUndefined();
  });

  it("says the limit is already reached when the account has used it all", () => {
    const window = available(reportFromStatus(acuStatus(30), NOW)).windows[0];
    expect(window?.runsOutAt).toBe(NOW.toISOString());
  });

  it("makes no forecast in the first days of a month", () => {
    const early = new Date("2026-10-02T12:00:00Z"); // 1.5 days in
    const report = available(reportFromStatus(acuStatus(5), early));
    expect(report.windows).toHaveLength(1);
    expect(report.details?.find((d) => d.id === "acu-forecast")?.value).toMatch(/after 3 days/);
    expect(weather(5, new Date("2026-10-04T00:00:00Z"))).toBeDefined(); // exactly 3 days
  });

  it("pins the weather beside the ACU bar by default", () => {
    const report = available(reportFromStatus(acuStatus(5), NOW));
    expect(report.windows.map((w) => [w.id, w.summary])).toEqual([
      ["acu-period", true],
      ["acu-forecast", true],
    ]);
  });
});

describe("fetchUsage", () => {
  it("posts the login to the stored server and returns the report", async () => {
    const fetchApi = respond(realStatus);
    const report = await fetchUsage(input, deps(fetchApi));
    expect(report.status).toBe("available");
    const [url, init] = vi.mocked(fetchApi).mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
    );
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({
      metadata: {
        apiKey: "SECRET-KEY",
        ideName: "devin",
        ideVersion: "3000.6.2",
        extensionVersion: "3000.6.2",
        locale: "en",
      },
    });
  });

  it("never sends the key to a host that is not allowed", async () => {
    for (const serverUrl of [
      "https://evil.example.com",
      "http://server.codeium.com",
      "https://server.codeium.com.evil.example.com",
    ]) {
      const fetchApi = respond(realStatus);
      await expect(
        fetchUsage(
          input,
          deps(fetchApi, async () => ({ ...login, serverUrl })),
        ),
      ).rejects.toThrow(/Refusing to send/);
      expect(fetchApi).not.toHaveBeenCalled();
    }
  });

  it("allows an extra host a company configures, and only exactly that host", async () => {
    const env = { WUKONG_DEVIN_API_HOSTS: "devin.corp.example, other.corp.example" };
    expect(allowedHosts(env).has("devin.corp.example")).toBe(true);
    expect(allowedHosts(env).has("corp.example")).toBe(false);
    const fetchApi = respond(realStatus);
    const report = await fetchUsage(input, {
      ...deps(fetchApi, async () => ({ ...login, serverUrl: "https://devin.corp.example" })),
      env,
    });
    expect(report.status).toBe("available");
  });

  it("reports a rejected login instead of an error", async () => {
    for (const status of [401, 403]) {
      expect(await fetchUsage(input, deps(respond({}, status)))).toEqual({
        status: "unavailable",
        problem: { kind: "rejected", status },
      });
    }
  });

  it("errors on a server failure without echoing the response or the key", async () => {
    const error = await fetchUsage(input, deps(respond({ echo: "SECRET-KEY" }, 500))).catch(
      (e: Error) => e,
    );
    expect((error as Error).message).toBe("Devin usage API returned 500");
  });

  it("names the real reason when the connection fails, never the key", async () => {
    const failing = (cause: object) =>
      vi.fn(async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause });
      }) as unknown as typeof fetch;
    const refused = await fetchUsage(input, deps(failing({ code: "ECONNREFUSED" }))).catch(
      (e: Error) => e,
    );
    expect((refused as Error).message).toBe("Could not reach server.codeium.com: ECONNREFUSED");
    const cert = await fetchUsage(
      input,
      deps(failing({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })),
    ).catch((e: Error) => e);
    expect((cert as Error).message).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE.*NODE_EXTRA_CA_CERTS/);
    expect((cert as Error).message).not.toContain("SECRET-KEY");
  });

  it("asks the user to sign in when there is no login", async () => {
    await expect(
      fetchUsage(
        input,
        deps(respond({}), async () => null as never),
      ),
    ).rejects.toThrow(/not signed in/);
  });
});

describe("login file and discovery", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function credentials(text: string): string {
    dir = mkdtempSync(join(tmpdir(), "devin-creds-"));
    const path = join(dir, "credentials.toml");
    writeFileSync(path, text);
    return path;
  }

  it("reads the key and server from credentials.toml", async () => {
    const path = credentials(
      'windsurf_api_key = "abc123"\napi_server_url = "https://server.codeium.com"\nother = 1\r\n',
    );
    expect(await readDevinLogin(path)).toEqual({
      apiKey: "abc123",
      serverUrl: "https://server.codeium.com",
    });
  });

  it("returns null for a missing file or one without both values", async () => {
    expect(await readDevinLogin(join(tmpdir(), "no-such-devin-file.toml"))).toBeNull();
    expect(await readDevinLogin(credentials('windsurf_api_key = "abc"\n'))).toBeNull();
  });

  it("offers one account when signed in, and never exposes the key or an email", async () => {
    const accounts = await discover({ kind: "global" }, async () => login);
    expect(accounts).toEqual([
      { key: "default", label: "Devin CLI", harness: "Devin", input: { store: "devin-cli" } },
    ]);
    expect(JSON.stringify(accounts)).not.toContain("SECRET-KEY");
  });

  it("offers nothing when signed out, or for a session on another provider", async () => {
    expect(await discover({ kind: "global" }, async () => null)).toEqual([]);
    expect(
      await discover({ kind: "session", provider: "claude", env: {} }, async () => login),
    ).toEqual([]);
    expect(
      (await discover({ kind: "session", provider: "devin", env: {} }, async () => login)).length,
    ).toBe(1);
  });
});
