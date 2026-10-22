import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_IDLE_RELEASE,
  getIdleReleaseSettings,
  resetIdleReleaseSettingsForTests,
  setIdleReleaseSettings,
  wrapIdleReleaseConfigStore,
} from "./idle-release-settings.js";

describe("idle release settings", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "idle-release-"));
    previousHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = home;
    resetIdleReleaseSettingsForTests();
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = previousHome;
    }
    resetIdleReleaseSettingsForTests();
    rmSync(home, { recursive: true, force: true });
  });

  const configPath = () => path.join(home, "daemon.json");
  const writeDaemon = (daemon: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    writeFileSync(configPath(), JSON.stringify({ ...extra, daemon }), "utf8");

  it("reads defaults when daemon.json is missing", () => {
    expect(getIdleReleaseSettings()).toEqual({ enabled: true, minutes: 15 });
    expect(DEFAULT_IDLE_RELEASE).toEqual({ enabled: true, minutes: 15 });
  });

  it("reads a persisted value", () => {
    writeDaemon({ idleRelease: { enabled: false, minutes: 30 } });
    expect(getIdleReleaseSettings()).toEqual({ enabled: false, minutes: 30 });
  });

  it.each(["15", 0, -5, 99999, 1.5])("falls back to 15 for bad minutes on disk (%s)", (bad) => {
    writeDaemon({ idleRelease: { enabled: false, minutes: bad } });
    expect(getIdleReleaseSettings()).toEqual({ enabled: false, minutes: 15 });
  });

  it("rejects bad minutes in a patch and leaves disk unchanged", () => {
    writeDaemon({ idleRelease: { enabled: true, minutes: 20 } });
    const before = readFileSync(configPath(), "utf8");
    expect(() => setIdleReleaseSettings({ minutes: 0 })).toThrow();
    expect(() => setIdleReleaseSettings({ minutes: 1441 })).toThrow();
    expect(() => setIdleReleaseSettings({ minutes: 2.5 })).toThrow();
    expect(() => setIdleReleaseSettings({ enabled: "yes" as unknown as boolean })).toThrow();
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(getIdleReleaseSettings()).toEqual({ enabled: true, minutes: 20 });
  });

  it("persists a patch without dropping other daemon.json keys", () => {
    writeDaemon({ requireSubagentApproval: false }, { requireSubagentApproval: false, other: 1 });
    const result = setIdleReleaseSettings({ minutes: 7 });
    expect(result).toEqual({ enabled: true, minutes: 7 });
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(raw.daemon.requireSubagentApproval).toBe(false);
    expect(raw.requireSubagentApproval).toBe(false);
    expect(raw.other).toBe(1);
    expect(raw.daemon.idleRelease).toEqual({ enabled: true, minutes: 7 });
  });

  it("config store get/patch carry idleRelease", () => {
    const broadcast = vi.fn();
    const store = {
      get: () => ({ base: true }),
      patch: (p: Record<string, unknown>) => ({ base: true, ...p }),
    };
    const ws = { daemonConfigStore: store, broadcastDaemonConfigChanged: broadcast };
    wrapIdleReleaseConfigStore(ws);
    wrapIdleReleaseConfigStore(ws);

    expect((store.get() as Record<string, unknown>).idleRelease).toEqual({
      enabled: true,
      minutes: 15,
    });
    const merged = store.patch({ idleRelease: { minutes: 5 } }) as Record<string, unknown>;
    expect(merged.idleRelease).toEqual({ enabled: true, minutes: 5 });
    expect(broadcast).toHaveBeenCalledTimes(1);

    store.patch({ other: 1 });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(() => store.patch({ idleRelease: { minutes: 0 } })).toThrow();
  });

  it("composes on top of an earlier wrapper", () => {
    const store = {
      get: (): object => ({ a: 1 }),
      patch: (p: Record<string, unknown>): object => ({ a: 1, ...p }),
    };
    const og = store.get;
    store.get = () => ({ ...og(), earlier: true });
    wrapIdleReleaseConfigStore({ daemonConfigStore: store });
    expect(store.get()).toMatchObject({ a: 1, earlier: true, idleRelease: DEFAULT_IDLE_RELEASE });
  });

  it("drops a cached read made before the daemon home was known", () => {
    delete process.env.PASEO_HOME;
    expect(getIdleReleaseSettings()).toEqual(DEFAULT_IDLE_RELEASE);
    writeDaemon({ idleRelease: { enabled: false, minutes: 40 } });
    const store = { get: (): object => ({}), patch: (p: Record<string, unknown>): object => p };
    wrapIdleReleaseConfigStore({ paseoHome: home, daemonConfigStore: store });
    expect(getIdleReleaseSettings()).toEqual({ enabled: false, minutes: 40 });
  });
});
