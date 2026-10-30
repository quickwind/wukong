import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { STATE_FILE, type DaemonState } from "./support/env";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !alive(pid);
}

/** Pids this run recorded, and only those. Nothing is ever found by process name. */
function daemonPidFromHome(home: string): number | null {
  const file = path.join(home, "paseo.pid");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STATE_FILE)) return;
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as DaemonState;
  const pids = [state.pid, daemonPidFromHome(state.home)].filter(
    (pid): pid is number => typeof pid === "number" && pid > 1 && pid !== process.pid,
  );
  for (const pid of new Set(pids)) {
    if (!alive(pid)) continue;
    process.kill(pid, "SIGTERM");
    if (!(await waitGone(pid, 15_000))) {
      process.kill(pid, "SIGKILL");
      await waitGone(pid, 5_000);
    }
  }
  if (process.env.IRIX_E2E_KEEP_HOME !== "1") {
    rmSync(state.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  rmSync(STATE_FILE, { force: true });
}
