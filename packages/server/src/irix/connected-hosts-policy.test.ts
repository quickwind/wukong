import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedHosts } from "../server/connected-hosts/index.js";
import { createIrixConnectedHosts } from "./connected-hosts-policy.js";
import { activateIrixPolicy } from "./policy.js";
import { irixServerFeatures, isIrixToolBlocked } from "./restrictions.js";

describe("Irix connected hosts", () => {
  const self = { serverId: "srv", label: "host" };
  let deactivate: () => void;

  beforeEach(() => {
    deactivate = activateIrixPolicy();
  });
  afterEach(() => {
    deactivate();
    vi.unstubAllEnvs();
  });

  it("lists nothing and refuses every change", async () => {
    const hosts = createIrixConnectedHosts("/nonexistent", self);
    expect(hosts).not.toBeInstanceOf(ConnectedHosts);
    await expect(hosts.list()).resolves.toEqual({ self, hosts: [] });
    await expect(
      hosts.add({ connection: "127.0.0.1:1" } as never, { sourceId: "owner", manageSources: true }),
    ).rejects.toMatchObject({ code: "HOSTS_DISABLED" });
    await expect(hosts.openRoute({} as never)).rejects.toMatchObject({ code: "HOSTS_DISABLED" });
    await expect(hosts.close()).resolves.toBeUndefined();
  });

  it("does not advertise the feature and hides list_hosts", () => {
    expect(irixServerFeatures()).toMatchObject({ connectedHosts: false, hostMultiplexing: false });
    expect(isIrixToolBlocked("list_hosts")).toBe(true);
  });

  it("IRIX_UNRESTRICTED does not lift it, IRIX_ENABLE_CONNECTED_HOSTS does", async () => {
    vi.stubEnv("IRIX_UNRESTRICTED", "1");
    vi.stubEnv("IRIX_ALLOW_AGENT_MESSAGING", "1");
    expect(irixServerFeatures()).toMatchObject({ connectedHosts: false });
    expect(isIrixToolBlocked("list_hosts")).toBe(true);
    vi.stubEnv("IRIX_ENABLE_CONNECTED_HOSTS", "1");
    expect(irixServerFeatures()).not.toHaveProperty("connectedHosts");
    expect(isIrixToolBlocked("list_hosts")).toBe(false);
    const hosts = createIrixConnectedHosts("/nonexistent", self);
    expect(hosts).toBeInstanceOf(ConnectedHosts);
    await hosts.close();
  });

  it("is the upstream registry when the Irix policy is off", async () => {
    deactivate();
    const hosts = createIrixConnectedHosts("/nonexistent", self);
    expect(hosts).toBeInstanceOf(ConnectedHosts);
    await hosts.close();
    deactivate = activateIrixPolicy();
  });
});
