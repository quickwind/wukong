// Irix edition entry. daemon-worker calls this first, before it loads config or opens a
// socket. Everything Irix-specific that has to run at
// daemon start lives here, which keeps upstream files to a one-line import.

import { activateIrixPolicy, isIrixActive } from "./policy.js";
import { devinUsageHosts } from "./devin-hosts.js";
import { allowEgressHost, installEgressGuard } from "./egress-guard.js";

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

  const allowedHosts = process.env.IRIX_ALLOWED_HOSTS ?? process.env.WUKONG_ALLOWED_HOSTS ?? "";
  for (const host of allowedHosts.split(",")) {
    if (host.trim()) {
      allowEgressHost(host);
    }
  }

  // The Devin usage plugin runs inside this guard and must reach Devin's own servers.
  for (const host of devinUsageHosts()) {
    allowEgressHost(host);
  }

  activateIrixPolicy();

  installEgressGuard({
    onBlocked: (error) => {
      process.stderr.write(`[irix] ${error.message}\n`);
    },
  });
}

export const applyWukongEdition = applyIrixEdition;

// daemon-worker imports this module first so the policy is in force before upstream modules
// (the forge registry builds itself at import time) are evaluated.
applyIrixEdition();
