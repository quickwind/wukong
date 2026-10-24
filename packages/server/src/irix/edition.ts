// Irix edition entry. daemon-worker calls this first, before it loads config or opens a
// socket. Everything Irix-specific that has to run at
// daemon start lives here, which keeps upstream files to a one-line import.

import { activateIrixPolicy, isIrixActive } from "./policy.js";
import { CLAUDE_USAGE_HOSTS } from "./claude-hosts.js";
import { devinUsageHosts } from "./devin-hosts.js";
import { allowEgressHost, installEgressGuard } from "./egress-guard.js";
import { IRIX_HOST_CAPS_ENV, irixHostCapsEnvValue } from "./host-caps.js";

export function applyIrixEdition(): void {
  if (isIrixActive()) {
    return;
  }
  // The relay is a cloud service. A launch-time override also locks it against config edits.
  process.env.PASEO_RELAY_ENABLED = "false";

  // Irix has no desktop app: the daemon serves the web UI unless the launch says otherwise.
  process.env.PASEO_WEB_UI_ENABLED ??= "true";

  // No dictation or voice mode, so no speech models: nothing to download at startup.
  process.env.PASEO_DICTATION_ENABLED = "false";
  process.env.PASEO_VOICE_MODE_ENABLED = "false";

  const allowedHosts = process.env.IRIX_ALLOWED_HOSTS ?? "";
  for (const host of allowedHosts.split(",")) {
    if (host.trim()) {
      allowEgressHost(host);
    }
  }

  // The Devin usage plugin runs inside this guard and must reach Devin's own servers.
  for (const host of devinUsageHosts()) {
    allowEgressHost(host);
  }

  // The Claude usage plugin likewise reaches api.anthropic.com for the account's spend cap.
  for (const host of CLAUDE_USAGE_HOSTS) {
    allowEgressHost(host);
  }

  // The terminal worker is a forked process with its own copy of the policy flag; it inherits
  // this marker instead (see windows-shell.ts).
  process.env.IRIX_EDITION_ACTIVE = "1";

  // Plugin servers are forked from this process: this is how they learn what Irix does for Devin.
  process.env[IRIX_HOST_CAPS_ENV] = irixHostCapsEnvValue();

  activateIrixPolicy();

  installEgressGuard({
    onBlocked: (error) => {
      process.stderr.write(`[irix] ${error.message}\n`);
    },
  });
}

// daemon-worker imports this module first so the policy is in force before upstream modules
// (the forge registry builds itself at import time) are evaluated.
applyIrixEdition();
