// Irix edition: deny-by-default network policy for the daemon process.
//
// Every outbound TCP/TLS/WebSocket/fetch connection in this process goes through
// `net.Socket.prototype.connect`, so one hook there covers relay, Hub, push, speech
// model downloads, plugin registries, update checks, and anything upstream adds later.
// Only loopback, local sockets, and explicitly allowed hosts (the company GitLab) pass.
// Child processes (provider CLIs, git, npm) are outside this process and unaffected.

import net from "node:net";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export class EgressBlockedError extends Error {
  constructor(
    readonly host: string,
    readonly port: number | undefined,
  ) {
    super(
      `Irix blocked a connection to ${host}${port === undefined ? "" : `:${port}`}. ` +
        "This edition only connects to this machine and to hosts on its allowlist.",
    );
    this.name = "EgressBlockedError";
  }
}

function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (LOOPBACK_NAMES.has(normalized) || normalized.endsWith(".localhost")) {
    return true;
  }
  if (net.isIPv4(normalized)) {
    return normalized.startsWith("127.");
  }
  return net.isIPv6(normalized) && normalized.startsWith("::ffff:127.");
}

const allowedHosts = new Set<string>();

/** Allow connections to `host` (name or IP, no port). Returns a function that revokes it. */
export function allowEgressHost(host: string): () => void {
  const normalized = normalizeHost(host);
  allowedHosts.add(normalized);
  return () => {
    allowedHosts.delete(normalized);
  };
}

function isAllowed(host: string): boolean {
  const normalized = normalizeHost(host);
  return isLoopbackHost(normalized) || allowedHosts.has(normalized);
}

interface ConnectTarget {
  local: boolean;
  host: string;
  port: number | undefined;
}

// Mirrors the argument forms of `Socket.prototype.connect`: (options), (path), (port[, host]),
// and the normalized array.
function parseConnectArgs(args: unknown[]): ConnectTarget {
  // net.connect() hands Socket#connect its already-normalized `[options, callback]` array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "object" && first !== null) {
    const options = first as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof options.path === "string") {
      return { local: true, host: options.path, port: undefined };
    }
    const host = typeof options.host === "string" && options.host ? options.host : "localhost";
    return { local: false, host, port: toPort(options.port) };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) {
    return { local: true, host: first, port: undefined };
  }
  const host = typeof args[1] === "string" && args[1] ? args[1] : "localhost";
  return { local: false, host, port: toPort(first) };
}

function toPort(value: unknown): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) ? port : undefined;
}

// Mirrors the argument forms of `Server#listen`: (options), (port[, host]), (path).
function listenHost(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    const { host } = first as { host?: unknown };
    return typeof host === "string" ? host : undefined;
  }
  return typeof args[1] === "string" ? args[1] : undefined;
}

export interface EgressGuardOptions {
  /** Called once per blocked destination, for logging. */
  onBlocked?: (error: EgressBlockedError) => void;
}

let uninstallActive: (() => void) | null = null;

/** Installs the guard on `net`. Idempotent; returns a function that removes it. */
export function installEgressGuard(options: EgressGuardOptions = {}): () => void {
  if (uninstallActive) {
    return uninstallActive;
  }

  const originalConnect = net.Socket.prototype.connect;
  const originalListen = net.Server.prototype.listen;
  const reported = new Set<string>();

  function block(host: string, port: number | undefined): EgressBlockedError {
    const error = new EgressBlockedError(host, port);
    const key = `${normalizeHost(host)}:${port ?? ""}`;
    if (!reported.has(key)) {
      reported.add(key);
      options.onBlocked?.(error);
    }
    return error;
  }

  net.Socket.prototype.connect = function guardedConnect(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    const target = parseConnectArgs(args);
    if (!target.local && !isAllowed(target.host)) {
      const error = block(target.host, target.port);
      // Same contract as a refused connection: the socket errors asynchronously.
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return (originalConnect as (...rest: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  net.Server.prototype.listen = function guardedListen(this: net.Server, ...args: unknown[]) {
    const host = listenHost(args);
    // Allowlisted remote hosts are for connecting out; the daemon itself only listens locally.
    if (typeof host === "string" && !isLoopbackHost(host)) {
      throw new EgressBlockedError(host, undefined);
    }
    return (originalListen as (...rest: unknown[]) => net.Server).apply(this, args);
  } as typeof net.Server.prototype.listen;

  uninstallActive = () => {
    net.Socket.prototype.connect = originalConnect;
    net.Server.prototype.listen = originalListen;
    uninstallActive = null;
  };
  return uninstallActive;
}
