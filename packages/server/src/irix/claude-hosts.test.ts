import net from "node:net";
import { describe, expect, it } from "vitest";

import { allowedHosts } from "../../../../plugins/irix-claude-usage/server/usage.js";
import { CLAUDE_USAGE_HOSTS } from "./claude-hosts.js";
import { allowEgressHost, installEgressGuard } from "./egress-guard.js";

describe("Claude usage hosts", () => {
  it("opens exactly the hosts the plugin is willing to send the login to", () => {
    expect([...allowedHosts()].sort()).toEqual([...CLAUDE_USAGE_HOSTS].sort());
  });

  it("lets the guard pass api.anthropic.com and still block look-alikes", () => {
    const blocked: string[] = [];
    const removeGuard = installEgressGuard({ onBlocked: (error) => blocked.push(error.host) });
    const removers = CLAUDE_USAGE_HOSTS.map((host) => allowEgressHost(host));
    try {
      for (const host of [
        "api.anthropic.com.evil.example.com",
        "console.anthropic.com",
        "api.anthropic.com",
      ]) {
        const socket = new net.Socket();
        socket.on("error", () => {});
        socket.connect(443, host);
        socket.destroy();
      }
      expect(blocked).toEqual(["api.anthropic.com.evil.example.com", "console.anthropic.com"]);
    } finally {
      for (const remove of removers) remove();
      removeGuard();
    }
  });
});
