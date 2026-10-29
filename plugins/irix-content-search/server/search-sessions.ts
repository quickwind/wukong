import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import type { Match, SearchOptions } from "../shared/rpc.js";
import { resolveRgBinary } from "./rg-binary.js";
import { buildRgArgs } from "./rg-args.js";
import { createRgOutputParser } from "./rg-output.js";

export const MAX_MATCHES = 500;
export const MAX_FILES = 100;
/** How long a finished search is kept for a client that stops polling. */
const FINISHED_TTL_MS = 60_000;
/** A running search that goes this long without a poll is stopped: its client has gone. */
export const NO_POLL_TIMEOUT_MS = 30_000;
/** Searches running at once, across all clients; a new one stops the oldest beyond this. */
export const MAX_RUNNING_SEARCHES = 4;
const MAX_STDERR = 10 * 1024;
const NOT_AVAILABLE = "Search is not available on this machine";

export interface PollResult {
  batch: Match[];
  cursor: number;
  done: boolean;
  truncated: boolean;
  error: string | null;
}

export interface SearchSessions {
  start(options: SearchOptions): { id: string };
  poll(id: string, cursor: number): PollResult;
  cancel(id: string): void;
  /** Stops every running search and clears timers; safe to call twice. */
  dispose(): void;
}

export interface SearchSessionsDeps {
  /** `undefined` looks the binary up; `null` means there is none. */
  rgPath?: string | null;
  /** Test hook: sees every spawned ripgrep process. */
  onSpawn?: (child: ChildProcess) => void;
}

interface Session {
  id: string;
  cwdKey: string;
  child: ChildProcess | null;
  matches: Match[];
  files: Set<string>;
  /** Output after this point is ignored: capped, cancelled or replaced. */
  stopped: boolean;
  done: boolean;
  truncated: boolean;
  error: string | null;
  expiry: ReturnType<typeof setTimeout> | null;
  /** Stops the search if no poll comes; restarted by each poll while it runs. */
  idle: ReturnType<typeof setTimeout> | null;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSearchSessions(deps: SearchSessionsDeps = {}): SearchSessions {
  const rgPath = deps.rgPath === undefined ? resolveRgBinary() : deps.rgPath;
  const sessions = new Map<string, Session>();
  const byCwd = new Map<string, Session>();

  function clearIdle(s: Session) {
    if (s.idle) clearTimeout(s.idle);
    s.idle = null;
  }

  function forget(s: Session) {
    if (s.expiry) clearTimeout(s.expiry);
    s.expiry = null;
    clearIdle(s);
    sessions.delete(s.id);
    if (byCwd.get(s.cwdKey) === s) byCwd.delete(s.cwdKey);
  }

  function finish(s: Session) {
    if (s.done) return;
    s.done = true;
    clearIdle(s);
    if (sessions.get(s.id) !== s) return;
    s.expiry = setTimeout(() => forget(s), FINISHED_TTL_MS);
    s.expiry.unref?.();
  }

  function stop(s: Session) {
    if (s.stopped) return;
    s.stopped = true;
    s.child?.kill();
  }

  function fail(s: Session, message: string) {
    if (s.error === null) s.error = message;
    stop(s);
  }

  /** Ends a running search now, so a later poll answers done with `message`. */
  function abandon(s: Session, message: string) {
    fail(s, message);
    finish(s);
  }

  function watchPolls(s: Session) {
    clearIdle(s);
    s.idle = setTimeout(
      () => abandon(s, "Search stopped: no client was polling."),
      NO_POLL_TIMEOUT_MS,
    );
    s.idle.unref?.();
  }

  function stopOldestBeyondLimit() {
    // Map order is start order, so the first running ones are the oldest.
    const running = [...sessions.values()].filter((s) => !s.done && !s.stopped);
    for (const s of running.slice(0, Math.max(0, running.length - MAX_RUNNING_SEARCHES + 1))) {
      abandon(s, "Search stopped: too many searches at once.");
    }
  }

  function ingest(s: Session, found: Match[]) {
    for (const m of found) {
      if (s.stopped) return;
      const newFile = !s.files.has(m.path);
      if ((newFile && s.files.size >= MAX_FILES) || s.matches.length >= MAX_MATCHES) {
        s.truncated = true;
        stop(s);
        return;
      }
      s.matches.push(m);
      if (newFile) s.files.add(m.path);
    }
  }

  function run(s: Session, rg: string, options: SearchOptions, cwd: string) {
    let child: ChildProcess;
    try {
      // buildRgArgs already ends with the "." path argument; adding another would make
      // ripgrep search the folder twice and report every match twice.
      child = spawn(rg, buildRgArgs(options), {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      s.error = `${NOT_AVAILABLE}: ${errorMessage(err)}`;
      finish(s);
      return;
    }
    s.child = child;
    deps.onSpawn?.(child);

    const parser = createRgOutputParser();
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      if (s.stopped) return;
      try {
        ingest(s, parser.push(chunk));
      } catch (err) {
        fail(s, `Could not read the search results: ${errorMessage(err)}`);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR)
        stderr = (stderr + chunk.toString("utf8")).slice(0, MAX_STDERR);
    });
    child.on("error", (err) => {
      // Spawn failures (missing or blocked binary) arrive here; a 'close' may or may not follow.
      if (!s.stopped) s.error ??= `${NOT_AVAILABLE}: ${err.message}`;
      s.stopped = true;
      finish(s);
    });
    child.on("close", (code, signal) => {
      if (!s.stopped) {
        try {
          ingest(s, parser.end());
        } catch (err) {
          fail(s, `Could not read the search results: ${errorMessage(err)}`);
        }
      }
      // 0: matches, 1: no matches, 2: an error (ripgrep's message is on stderr).
      if (code === 2) {
        s.error ??= stderr.trim() || "ripgrep failed";
      } else if (code !== 0 && code !== 1 && !s.stopped) {
        s.error ??= `ripgrep stopped unexpectedly (${signal ?? code})`;
      }
      finish(s);
    });
  }

  return {
    start(options) {
      const cwd = path.resolve(options.cwd);
      const s: Session = {
        id: randomUUID(),
        cwdKey: process.platform === "win32" ? cwd.toLowerCase() : cwd,
        child: null,
        matches: [],
        files: new Set(),
        stopped: false,
        done: false,
        truncated: false,
        error: null,
        expiry: null,
        idle: null,
      };
      const previous = byCwd.get(s.cwdKey);
      if (previous) stop(previous);
      stopOldestBeyondLimit();
      sessions.set(s.id, s);
      byCwd.set(s.cwdKey, s);

      if (!rgPath) {
        s.error = `${NOT_AVAILABLE}: ripgrep (rg) was not found.`;
        finish(s);
      } else if (!isDirectory(cwd)) {
        s.error = "Folder not found";
        finish(s);
      } else {
        run(s, rgPath, options, cwd);
        if (!s.done) watchPolls(s);
      }
      return { id: s.id };
    },

    poll(id, cursor) {
      const s = sessions.get(id);
      if (!s) {
        return { batch: [], cursor, done: true, truncated: false, error: "Search expired" };
      }
      if (!s.done) watchPolls(s);
      const next = Math.max(cursor, s.matches.length);
      const result: PollResult = {
        batch: s.matches.slice(cursor),
        cursor: next,
        done: s.done,
        truncated: s.truncated,
        error: s.error,
      };
      if (s.done && next >= s.matches.length) forget(s);
      return result;
    },

    cancel(id) {
      const s = sessions.get(id);
      if (!s) return;
      stop(s);
      forget(s);
    },

    dispose() {
      for (const s of sessions.values()) {
        stop(s);
        forget(s);
      }
    },
  };
}
