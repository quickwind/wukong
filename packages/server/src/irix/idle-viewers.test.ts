import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Session } from "../server/session.js";
import {
  attachIdleViewers,
  irixIdleMinutes,
  irixIdlePeriodMs,
  isIrixAgentViewed,
  viewedAgentIds,
} from "./idle-viewers.js";
import { activateIrixPolicy } from "./policy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-22T12:00:00Z");
const MIN = 60_000;

interface Activity {
  appVisible: boolean;
  focusedAgentId: string | null;
  lastActivityAt: Date;
}

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    appVisible: true,
    focusedAgentId: "a1",
    lastActivityAt: new Date(NOW - MIN),
    ...overrides,
  };
}

function serverWith(ws: object, value: Activity | null) {
  return { sessions: new Map([[ws, { session: { getClientActivity: () => value } }]]) };
}

afterEach(() => attachIdleViewers(undefined));

describe("viewedAgentIds", () => {
  it("is empty with no server attached", () => {
    expect(viewedAgentIds(NOW, 15).size).toBe(0);
  });

  it("includes a visible, focused, recent client", () => {
    attachIdleViewers(serverWith({}, activity()));
    expect([...viewedAgentIds(NOW, 15)]).toEqual(["a1"]);
  });

  it("excludes a client whose app is not visible", () => {
    attachIdleViewers(serverWith({}, activity({ appVisible: false })));
    expect(viewedAgentIds(NOW, 15).size).toBe(0);
  });

  it("excludes a client whose last activity is older than the window", () => {
    attachIdleViewers(serverWith({}, activity({ lastActivityAt: new Date(NOW - 16 * MIN) })));
    expect(viewedAgentIds(NOW, 15).size).toBe(0);
  });

  it("excludes a client with no focused agent", () => {
    attachIdleViewers(serverWith({}, activity({ focusedAgentId: null })));
    expect(viewedAgentIds(NOW, 15).size).toBe(0);
  });

  it("excludes a client with no activity record", () => {
    attachIdleViewers(serverWith({}, null));
    expect(viewedAgentIds(NOW, 15).size).toBe(0);
  });

  it("stops counting a client as soon as it disconnects", () => {
    const ws = {};
    const server = serverWith(ws, activity());
    attachIdleViewers(server);
    expect(viewedAgentIds(NOW, 15).has("a1")).toBe(true);
    server.sessions.delete(ws);
    expect(viewedAgentIds(NOW, 15).size).toBe(0);
  });

  it("tolerates a server without sessions", () => {
    attachIdleViewers({});
    expect(viewedAgentIds(NOW, 15).size).toBe(0);
  });
});

describe("upstream pins", () => {
  it("Session.getClientActivity exists and defaults its source to the current delivery source", () => {
    expect(typeof Session.prototype.getClientActivity).toBe("function");
    const source = readFileSync(path.join(here, "..", "server", "session.ts"), "utf8");
    expect(source).toContain("getClientActivity(source = this.delivery.currentSource)");
  });

  it("the ws server still iterates sessions as the accessor expects", () => {
    const source = readFileSync(path.join(here, "..", "server", "websocket-server.ts"), "utf8");
    expect(source).toContain("class VoiceAssistantWebSocketServer");
    expect(source).toContain("for (const [ws, connection] of this.sessions)");
    // The session records activity under the ws it came from, which is the key the accessor
    // passes back as `source`.
    expect(source).toContain("updateClientCapabilities(clientCapabilities, ws");
    expect(source).toContain("session.handleMessage(message.message, ws)");
  });
});

describe("idle period", () => {
  it("defaults to 15 minutes and takes IRIX_IDLE_MINUTES from 1 to 1440", () => {
    expect(irixIdleMinutes({})).toBe(15);
    expect(irixIdleMinutes({ IRIX_IDLE_MINUTES: "30" })).toBe(30);
    for (const bad of ["0", "1441", "1.5", "abc", ""]) {
      expect(irixIdleMinutes({ IRIX_IDLE_MINUTES: bad })).toBe(15);
    }
  });

  it("leaves upstream's period alone until Irix is active", () => {
    expect(irixIdlePeriodMs(3_600_000)).toBe(3_600_000);
    const deactivate = activateIrixPolicy();
    try {
      expect(irixIdlePeriodMs(3_600_000)).toBe(15 * MIN);
    } finally {
      deactivate();
    }
  });

  it("keeps a viewed agent only while Irix is active", () => {
    attachIdleViewers(serverWith({}, activity()));
    expect(isIrixAgentViewed("a1", NOW)).toBe(false);
    const deactivate = activateIrixPolicy();
    try {
      expect(isIrixAgentViewed("a1", NOW)).toBe(true);
      expect(isIrixAgentViewed("other", NOW)).toBe(false);
    } finally {
      deactivate();
    }
  });
});
