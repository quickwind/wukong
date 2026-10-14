import { describe, expect, it } from "vitest";

import { allowedHosts } from "../../../../plugins/irix-devin-usage/server/usage.js";
import { DEVIN_USAGE_HOSTS, devinUsageHosts } from "./devin-hosts.js";
import { allowEgressHost, installEgressGuard } from "./egress-guard.js";
import net from "node:net";

describe("Devin usage hosts", () => {
  it("opens exactly the hosts the plugin is willing to send the login to", () => {
    expect([...allowedHosts({})].sort()).toEqual([...DEVIN_USAGE_HOSTS].sort());
  });

  it("adds company hosts from IRIX_DEVIN_API_HOSTS in both places", () => {
    const env = { IRIX_DEVIN_API_HOSTS: "devin.corp.example, other.corp.example" };
    expect(devinUsageHosts(env)).toEqual([
      ...DEVIN_USAGE_HOSTS,
      "devin.corp.example",
      "other.corp.example",
    ]);
    expect([...allowedHosts(env)].sort()).toEqual([...devinUsageHosts(env)].sort());
  });

  it("lets the guard pass Devin's hosts and still block anything else", async () => {
    const blocked: string[] = [];
    const removeGuard = installEgressGuard({ onBlocked: (error) => blocked.push(error.host) });
    const removers = devinUsageHosts({}).map((host) => allowEgressHost(host));
    try {
      for (const host of [
        "evil.example.com",
        "server.codeium.com.evil.example.com",
        "server.codeium.com",
        "api.devin.ai",
      ]) {
        const socket = new net.Socket();
        socket.on("error", () => {});
        socket.connect(443, host);
        socket.destroy();
      }
      expect(blocked).toEqual(["evil.example.com", "server.codeium.com.evil.example.com"]);
    } finally {
      for (const remove of removers) remove();
      removeGuard();
    }
  });
});
