// Wukong's own home and port, so it never shares them with a Paseo installed on the same machine.
// Run from bin/wukong before the CLI starts.
//
// Wukong ignores the Paseo variables it inherits. A terminal opened inside Paseo exports
// PASEO_HOME and PASEO_HOST for Paseo's own daemon, and honouring them would point `wukong` at
// that daemon. WUKONG_HOME picks another home; `--home` on the command line still wins.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const WUKONG_DEFAULT_PORT = 6899;

export function wukongDefaultHome(homeDirectory: string = os.homedir()): string {
  return path.join(homeDirectory, ".wukong");
}

function expandHome(input: string, homeDirectory: string): string {
  if (input === "~") return homeDirectory;
  return /^~[\\/]/u.test(input) ? path.join(homeDirectory, input.slice(2)) : input;
}

/** Points the CLI at ~/.wukong (or WUKONG_HOME) and gives a fresh home a config on port 6899. */
export function applyWukongDefaults(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): void {
  delete env.PASEO_HOST;
  env.PASEO_HOME = env.WUKONG_HOME || wukongDefaultHome(homeDirectory);
  const home = path.resolve(expandHome(env.PASEO_HOME, homeDirectory));
  const config = path.join(home, "config.json");
  if (existsSync(config)) {
    enableAgentTools(config);
    return;
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        version: 1,
        daemon: { listen: `127.0.0.1:${WUKONG_DEFAULT_PORT}`, mcp: { injectIntoAgents: true } },
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Hands Paseo's own tools (message another agent, start one, ...) to every agent unless the config
 * already says otherwise. The daemon's built-in default is off, while the Settings page shows the
 * switch as on when the config has no value for it, so a fresh home looked enabled and was not.
 * A config that cannot be read, or that already has a value, is left exactly as it is.
 */
function enableAgentTools(configPath: string): void {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config === null || typeof config !== "object" || Array.isArray(config)) return;
    const daemon = config.daemon ?? {};
    if (typeof daemon !== "object" || Array.isArray(daemon)) return;
    const mcp = daemon.mcp ?? {};
    if (typeof mcp !== "object" || Array.isArray(mcp) || mcp.injectIntoAgents !== undefined) return;
    writeFileSync(
      configPath,
      `${JSON.stringify({ ...config, daemon: { ...daemon, mcp: { ...mcp, injectIntoAgents: true } } }, null, 2)}\n`,
    );
  } catch {
    // Unreadable or not JSON: the daemon reports that; do not make it worse.
  }
}
