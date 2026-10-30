import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bundledRgPath } from "./ripgrep.js";
import { irixHostCaps } from "./host-caps.js";

// edition.ts applies itself when it is first imported. Each test loads a fresh copy of the
// module graph, so the policy and the egress guard start from off, and puts the net
// prototypes and the guard's global back afterwards.

const VARIABLES = [
  "PASEO_RELAY_ENABLED",
  "PASEO_WEB_UI_ENABLED",
  "PASEO_DICTATION_ENABLED",
  "PASEO_VOICE_MODE_ENABLED",
  "IRIX_ALLOWED_HOSTS",
  "IRIX_EDITION_ACTIVE",
  "IRIX_HOST_CAPS",
  "IRIX_RG_PATH",
] as const;

const GUARD_KEY = Symbol.for("irix.allowEgressHost");
const realConnect = net.Socket.prototype.connect;
const realListen = net.Server.prototype.listen;

async function loadEdition() {
  vi.resetModules();
  const edition = await import("./edition.js");
  const policy = await import("./policy.js");
  return { edition, policy };
}

/** Connects a socket and resolves with the error it fails with, or null on connect. */
function connectOutcome(host: string, port: number): Promise<Error | null> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.once("connect", () => {
      socket.destroy();
      resolve(null);
    });
    socket.once("error", (error) => resolve(error));
    socket.connect(port, host);
  });
}

describe("what the Irix edition sets when the daemon starts", () => {
  const saved = new Map<string, string | undefined>();
  let stopPolicy: (() => void) | undefined;

  beforeEach(() => {
    for (const name of VARIABLES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    stopPolicy?.();
    stopPolicy = undefined;
    net.Socket.prototype.connect = realConnect;
    net.Server.prototype.listen = realListen;
    delete (globalThis as Record<symbol, unknown>)[GUARD_KEY];
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });

  it("turns the Irix policy on, and the relay, dictation and voice mode off", async () => {
    process.env.PASEO_RELAY_ENABLED = "true";
    process.env.PASEO_DICTATION_ENABLED = "true";
    process.env.PASEO_VOICE_MODE_ENABLED = "true";
    const { policy } = await loadEdition();
    stopPolicy = policy.activateIrixPolicy();

    expect(process.env.PASEO_RELAY_ENABLED).toBe("false");
    expect(process.env.PASEO_DICTATION_ENABLED).toBe("false");
    expect(process.env.PASEO_VOICE_MODE_ENABLED).toBe("false");
    expect(process.env.IRIX_EDITION_ACTIVE).toBe("1");
  });

  it("serves the web UI unless the launch turns it off", async () => {
    const first = await loadEdition();
    stopPolicy = first.policy.activateIrixPolicy();
    expect(process.env.PASEO_WEB_UI_ENABLED).toBe("true");
    stopPolicy();

    process.env.PASEO_WEB_UI_ENABLED = "false";
    const second = await loadEdition();
    stopPolicy = second.policy.activateIrixPolicy();
    expect(process.env.PASEO_WEB_UI_ENABLED).toBe("false");
  });

  it("publishes the host capabilities as JSON for plugin servers", async () => {
    const { policy } = await loadEdition();
    stopPolicy = policy.activateIrixPolicy();
    expect(JSON.parse(process.env.IRIX_HOST_CAPS ?? "{}")).toEqual(irixHostCaps());
  });

  it("points IRIX_RG_PATH at the bundled ripgrep only when one exists", async () => {
    const { policy } = await loadEdition();
    stopPolicy = policy.activateIrixPolicy();
    expect(process.env.IRIX_RG_PATH ?? null).toBe(bundledRgPath());
  });

  it("keeps an IRIX_RG_PATH the launch already set", async () => {
    process.env.IRIX_RG_PATH = "/opt/custom/rg";
    const { policy } = await loadEdition();
    stopPolicy = policy.activateIrixPolicy();
    expect(process.env.IRIX_RG_PATH).toBe("/opt/custom/rg");
  });

  it("refuses outbound connections to hosts that are not on the allowlist, and logs each one", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { policy } = await loadEdition();
      stopPolicy = policy.activateIrixPolicy();

      const error = await connectOutcome("example.invalid", 443);
      expect(error?.message).toMatch(/^Irix blocked a connection to example\.invalid:443\./u);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("[irix] Irix blocked a connection to example.invalid:443."),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("lets connections through to the hosts in IRIX_ALLOWED_HOSTS", async () => {
    process.env.IRIX_ALLOWED_HOSTS = " gitlab.corp.example , ,";
    const { policy } = await loadEdition();
    stopPolicy = policy.activateIrixPolicy();

    // Not resolvable, so the attempt fails in DNS, which proves it was not refused by the guard.
    const error = await connectOutcome("gitlab.corp.example", 443);
    expect(error).not.toBeNull();
    expect(error?.message).not.toMatch(/Irix blocked/u);
  });

  it("lets a plugin allow one more host through the global hook", async () => {
    const { policy } = await loadEdition();
    stopPolicy = policy.activateIrixPolicy();
    const allow = (globalThis as Record<symbol, unknown>)[GUARD_KEY] as (host: unknown) => void;
    expect(typeof allow).toBe("function");

    allow("plugin-target.corp.example");
    const error = await connectOutcome("plugin-target.corp.example", 443);
    expect(error?.message ?? "").not.toMatch(/Irix blocked/u);
    expect(() => allow("https://not-a-host/path")).toThrow(TypeError);
  });

  it("connects to loopback, and refuses to listen on any other address", async () => {
    const { policy } = await loadEdition();
    stopPolicy = policy.activateIrixPolicy();

    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      expect(await connectOutcome("127.0.0.1", port)).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(() => net.createServer().listen(0, "0.0.0.0")).toThrow(/Irix blocked/u);
  });

  it("does nothing a second time once the policy is on", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { edition, policy } = await loadEdition();
      stopPolicy = policy.activateIrixPolicy();

      process.env.PASEO_RELAY_ENABLED = "true";
      process.env.IRIX_ALLOWED_HOSTS = "late.corp.example";
      edition.applyIrixEdition();

      expect(process.env.PASEO_RELAY_ENABLED).toBe("true");
      const error = await connectOutcome("late.corp.example", 443);
      expect(error?.message).toMatch(/Irix blocked/u);
    } finally {
      stderr.mockRestore();
    }
  });
});
