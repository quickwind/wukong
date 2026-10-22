// Irix edition: idle release setting (close the provider process of long-idle agents).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface IdleReleaseSettings {
  enabled: boolean;
  minutes: number;
}

export const DEFAULT_IDLE_RELEASE: IdleReleaseSettings = { enabled: true, minutes: 15 };

const MIN_MINUTES = 1;
const MAX_MINUTES = 1440;

interface ConfigStoreLike {
  get(): object;
  patch(p: Record<string, unknown>): object;
}

interface IdleReleaseWsServer {
  paseoHome?: string;
  daemonConfigStore?: ConfigStoreLike;
  broadcastDaemonConfigChanged?(config: object): void;
}

let runtimePaseoHome: string | null = null;
let cached: IdleReleaseSettings | null = null;
const wrappedStores = new WeakSet<object>();

function isValidMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_MINUTES &&
    value <= MAX_MINUTES
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveConfigFilePath(paseoHome?: string | null): string | null {
  const home = paseoHome ?? runtimePaseoHome ?? process.env.PASEO_HOME;
  if (!home || !home.trim()) {
    return null;
  }
  return path.join(home.trim(), "daemon.json");
}

function readPersisted(paseoHome?: string | null): IdleReleaseSettings {
  const filePath = resolveConfigFilePath(paseoHome);
  if (!filePath || !existsSync(filePath)) {
    return { ...DEFAULT_IDLE_RELEASE };
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    const daemon = isRecord(raw) ? raw.daemon : undefined;
    const stored = isRecord(daemon) ? daemon.idleRelease : undefined;
    if (isRecord(stored)) {
      return {
        enabled:
          typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_IDLE_RELEASE.enabled,
        minutes: isValidMinutes(stored.minutes) ? stored.minutes : DEFAULT_IDLE_RELEASE.minutes,
      };
    }
  } catch {
    // Unreadable config falls back to the defaults.
  }
  return { ...DEFAULT_IDLE_RELEASE };
}

function writePersisted(settings: IdleReleaseSettings, paseoHome?: string | null): void {
  const filePath = resolveConfigFilePath(paseoHome);
  if (!filePath) {
    return;
  }
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    let current: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
        if (isRecord(parsed)) {
          current = parsed;
        }
      } catch {
        current = {};
      }
    }
    const daemon = isRecord(current.daemon) ? { ...current.daemon } : {};
    daemon.idleRelease = { ...settings };
    current.daemon = daemon;
    writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  } catch {
    // Keep the in-memory setting even if disk persistence fails.
  }
}

export function getIdleReleaseSettings(): IdleReleaseSettings {
  if (!cached) {
    cached = readPersisted();
  }
  return { ...cached };
}

export function setIdleReleaseSettings(
  patch: Partial<IdleReleaseSettings>,
  paseoHome?: string | null,
): IdleReleaseSettings {
  if (patch.minutes !== undefined && !isValidMinutes(patch.minutes)) {
    throw new Error(
      `idleRelease.minutes must be an integer between ${MIN_MINUTES} and ${MAX_MINUTES}`,
    );
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    throw new Error("idleRelease.enabled must be a boolean");
  }
  const next: IdleReleaseSettings = {
    enabled: patch.enabled ?? getIdleReleaseSettings().enabled,
    minutes: patch.minutes ?? getIdleReleaseSettings().minutes,
  };
  cached = next;
  writePersisted(next, paseoHome);
  return { ...next };
}

export function wrapIdleReleaseConfigStore(wsServer: IdleReleaseWsServer): void {
  if (wsServer.paseoHome) {
    runtimePaseoHome = wsServer.paseoHome;
  }
  const store = wsServer.daemonConfigStore;
  if (!store || typeof store.get !== "function" || typeof store.patch !== "function") {
    return;
  }
  if (wrappedStores.has(store)) {
    return;
  }
  wrappedStores.add(store);
  const originalGet = store.get.bind(store);
  const originalPatch = store.patch.bind(store);

  store.get = () => ({ ...originalGet(), idleRelease: getIdleReleaseSettings() });

  store.patch = (patch: Record<string, unknown>) => {
    const { idleRelease, ...rest } = patch;
    const hasIdleRelease = idleRelease !== undefined;
    if (hasIdleRelease) {
      if (!isRecord(idleRelease)) {
        throw new Error("idleRelease must be an object");
      }
      setIdleReleaseSettings({
        enabled: idleRelease.enabled as boolean | undefined,
        minutes: idleRelease.minutes as number | undefined,
      });
    }
    const merged = { ...originalPatch(rest), idleRelease: getIdleReleaseSettings() };
    if (hasIdleRelease) {
      wsServer.broadcastDaemonConfigChanged?.(merged);
    }
    return merged;
  };
}

export function resetIdleReleaseSettingsForTests(): void {
  cached = null;
  runtimePaseoHome = null;
}
