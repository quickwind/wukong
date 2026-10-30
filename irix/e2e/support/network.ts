import type { Page } from "@playwright/test";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface NetworkLog {
  /** Every http(s)/ws(s) URL the page requested, in order. */
  urls: string[];
  /** The URLs whose host is not 127.0.0.1, localhost or ::1. */
  offHost(): string[];
}

/** Starts recording every request (and WebSocket) of the page. Call before the first goto. */
export function recordNetwork(page: Page): NetworkLog {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  page.on("websocket", (socket) => urls.push(socket.url()));
  return {
    urls,
    offHost: () => urls.filter(isOffHost),
  };
}

/** data:, blob: and about: never leave the machine; everything else must be loopback. */
export function isOffHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (["data:", "blob:", "about:"].includes(parsed.protocol)) return false;
  return !LOCAL_HOSTS.has(parsed.hostname);
}
