// Irix: what "Create merge request" needs to know about a checkout (its `origin` and `upstream`
// remotes, and the id and default branch of the two projects) hardly ever changes, and finding it
// costs git processes and GitLab requests that queue behind everything else the daemon is doing.
// So it is looked up once and kept: the remotes until the repository's config file changes (the
// file is checked with a `stat`, no process), the projects for a day.

import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { runGitCommand } from "../../utils/run-git-command.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Entry<V> {
  fingerprint: string;
  at: number;
  value: Promise<V>;
}

/** Values kept while their fingerprint is unchanged and for at most `ttlMs`. */
export class FingerprintCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly ttlMs: number = DAY_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** A null fingerprint means "cannot tell whether it changed": look it up, keep nothing. */
  async get(key: string, fingerprint: string | null, load: () => Promise<V>): Promise<V> {
    if (fingerprint === null) {
      return load();
    }
    const entry = this.entries.get(key);
    if (entry && entry.fingerprint === fingerprint && this.now() - entry.at < this.ttlMs) {
      return entry.value;
    }
    const value = load();
    const fresh: Entry<V> = { fingerprint, at: this.now(), value };
    this.entries.set(key, fresh);
    // A failed lookup must not be remembered.
    value.catch(() => {
      if (this.entries.get(key) === fresh) this.entries.delete(key);
    });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface RemoteUrls {
  origin: string | null;
  upstream: string | null;
}

export interface UpstreamCaches {
  remotes: FingerprintCache<RemoteUrls>;
  projects: FingerprintCache<unknown>;
}

export function createUpstreamCaches(): UpstreamCaches {
  return { remotes: new FingerprintCache(), projects: new FingerprintCache() };
}

export const defaultUpstreamCaches = createUpstreamCaches();

const commonDirs = new Map<string, string>();

/** The directory that holds the repository's config; found once per checkout, with one process. */
async function commonDirOf(cwd: string): Promise<string | null> {
  const known = commonDirs.get(cwd);
  if (known) return known;
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--git-common-dir"], { cwd });
    const dir = stdout.trim();
    if (!dir) return null;
    const absolute = isAbsolute(dir) ? dir : resolve(cwd, dir);
    commonDirs.set(cwd, absolute);
    return absolute;
  } catch {
    // Not a repository (yet): ask again next time.
    return null;
  }
}

/** Changes whenever the repository's config file (where remotes live) is written. */
export async function gitConfigFingerprint(cwd: string): Promise<string | null> {
  const dir = await commonDirOf(cwd);
  if (!dir) return null;
  try {
    const { mtimeMs, size } = await stat(join(dir, "config"));
    return `${mtimeMs}:${size}`;
  } catch {
    return null;
  }
}
