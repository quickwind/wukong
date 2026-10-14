import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  allowEgressHost,
  EgressBlockedError,
  installEgressGuard,
  isLoopbackHost,
} from "./egress-guard.js";

function connectError(...args: Parameters<typeof net.connect>): Promise<Error> {
  return new Promise((resolve) => {
    const socket = net.connect(...args);
    socket.once("error", resolve);
    socket.once("connect", () => {
      socket.destroy();
      resolve(new Error("connected"));
    });
  });
}

describe("egress guard", () => {
  let uninstall: () => void;
  const blocked: string[] = [];

  beforeEach(() => {
    blocked.length = 0;
    uninstall = installEgressGuard({ onBlocked: (error) => blocked.push(error.host) });
  });

  afterEach(() => uninstall());

  it("recognises loopback spellings", () => {
    for (const host of ["localhost", "127.0.0.1", "127.8.0.1", "::1", "[::1]", "a.localhost"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["example.com", "10.0.0.1", "192.168.1.1", "0.0.0.0", "::"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it("blocks a TCP connection to a remote host in every call form", async () => {
    const forms: Array<Parameters<typeof net.connect>> = [
      [{ host: "203.0.113.5", port: 443 }],
      [443, "203.0.113.5"],
      [{ host: "example.invalid", port: 80 }],
    ];
    for (const form of forms) {
      expect(await connectError(...form)).toBeInstanceOf(EgressBlockedError);
    }
    expect(blocked).toEqual(["203.0.113.5", "example.invalid"]);
  });

  it("blocks fetch and websocket-style http requests", async () => {
    await expect(fetch("https://api.example.invalid/x")).rejects.toThrow();
    const error = await new Promise<Error>((resolve) => {
      http.get("http://203.0.113.5/").once("error", resolve);
    });
    expect(error).toBeInstanceOf(EgressBlockedError);
  });

  it("lets loopback connections through", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toBe("ok");
    await new Promise((resolve) => server.close(resolve));
  });

  it("lets an allowlisted host through to the real connect", async () => {
    const revoke = allowEgressHost("203.0.113.5");
    const socket = net.connect({ host: "203.0.113.5", port: 9 });
    const errors: Error[] = [];
    socket.on("error", (error) => errors.push(error));
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    revoke();
    expect(errors.some((error) => error instanceof EgressBlockedError)).toBe(false);
    expect(blocked).toEqual([]);
  });

  it("refuses to listen on a non-loopback address, even an allowlisted one", () => {
    const revoke = allowEgressHost("203.0.113.5");
    for (const host of ["0.0.0.0", "::", "203.0.113.5"]) {
      expect(() => net.createServer().listen({ host, port: 0 })).toThrow(EgressBlockedError);
    }
    revoke();
  });

  it("restores the original behaviour when uninstalled", async () => {
    uninstall();
    const error = await connectError({ host: "127.0.0.1", port: 1 });
    expect(error).not.toBeInstanceOf(EgressBlockedError);
    uninstall = installEgressGuard();
  });
});
