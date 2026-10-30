import { readFileSync } from "node:fs";
import path from "node:path";

export const E2E_DIR = path.resolve(__dirname, "..");
export const REPO_ROOT = path.resolve(E2E_DIR, "..", "..");
export const OUTPUT_DIR = path.join(E2E_DIR, ".output");
export const STATE_FILE = path.join(OUTPUT_DIR, "daemon-state.json");

export interface DaemonState {
  baseUrl: string;
  port: number;
  home: string;
  /** PID of the `irix daemon run` process this run started. */
  pid: number;
}

export function readDaemonState(): DaemonState {
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as DaemonState;
}
