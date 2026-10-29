import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Match, SearchOptions } from "../shared/rpc.js";
import { resolveRgBinary } from "./rg-binary.js";
import {
  MAX_FILES,
  MAX_MATCHES,
  MAX_RUNNING_SEARCHES,
  NO_POLL_TIMEOUT_MS,
  type PollResult,
  type SearchSessions,
  createSearchSessions,
} from "./search-sessions.js";

const RG = resolveRgBinary();

function options(cwd: string, query: string, extra: Partial<SearchOptions> = {}): SearchOptions {
  return {
    cwd,
    query,
    caseSensitive: false,
    regex: false,
    wholeWord: false,
    include: "",
    exclude: "",
    ...extra,
  };
}

interface Drained {
  matches: Match[];
  last: PollResult;
  polls: PollResult[];
}

async function drain(sessions: SearchSessions, id: string, cursor = 0): Promise<Drained> {
  const matches: Match[] = [];
  const polls: PollResult[] = [];
  for (let i = 0; i < 500; i += 1) {
    const result = sessions.poll(id, cursor);
    polls.push(result);
    matches.push(...result.batch);
    cursor = result.cursor;
    if (result.done) return { matches, last: result, polls };
    await delay(10);
  }
  throw new Error("search did not finish");
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

describe("createSearchSessions without rg", () => {
  it("reports that search is not available", () => {
    const sessions = createSearchSessions({ rgPath: null });
    const { id } = sessions.start(options(tmpdir(), "needle"));
    const result = sessions.poll(id, 0);
    expect(result.done).toBe(true);
    expect(result.batch).toEqual([]);
    expect(result.error).toMatch(/^Search is not available on this machine/);
  });

  it("returns Search expired for an unknown id", () => {
    const sessions = createSearchSessions({ rgPath: null });
    expect(sessions.poll("nope", 0)).toEqual({
      batch: [],
      cursor: 0,
      done: true,
      truncated: false,
      error: "Search expired",
    });
  });

  it("forgets a finished session after 60 s", () => {
    vi.useFakeTimers();
    try {
      const sessions = createSearchSessions({ rgPath: "/does/not/matter" });
      const { id } = sessions.start(options("/definitely/not/a/folder/irix", "needle"));
      vi.advanceTimersByTime(60_000);
      expect(sessions.poll(id, 0).error).toBe("Search expired");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(!RG)("createSearchSessions with a real ripgrep (needs rg on PATH)", () => {
  let root: string;
  let spawned: ChildProcess[];

  function makeSessions(): SearchSessions {
    return createSearchSessions({ rgPath: RG, onSpawn: (child) => spawned.push(child) });
  }

  beforeAll(() => {
    spawned = [];
    root = mkdtempSync(path.join(tmpdir(), "irix-content-search-"));
    mkdirSync(path.join(root, "small", "sub"), { recursive: true });
    writeFileSync(path.join(root, "small", "a.txt"), "first line\n  the needle is here\nlast\n");
    writeFileSync(path.join(root, "small", "sub", "b.txt"), "no match\nanother needle\n");

    mkdirSync(path.join(root, "dotdirs", ".git", "hooks"), { recursive: true });
    mkdirSync(path.join(root, "dotdirs", ".github"));
    writeFileSync(path.join(root, "dotdirs", ".git", "hooks", "x.sample"), "needle\n");
    writeFileSync(path.join(root, "dotdirs", ".github", "y.yml"), "needle\n");

    mkdirSync(path.join(root, "many-matches"));
    writeFileSync(
      path.join(root, "many-matches", "big.txt"),
      Array.from({ length: MAX_MATCHES * 3 }, (_, i) => `needle ${i}`).join("\n"),
    );

    // Enough output (about 600 KB) that ripgrep is still blocked writing to the pipe when the cap
    // trips; with 150 files its 75 KB could fit the pipe buffer and it could exit first.
    mkdirSync(path.join(root, "many-files"));
    for (let i = 0; i < 1000; i += 1) {
      writeFileSync(path.join(root, "many-files", `f${i}.txt`), "one needle\n");
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds a literal match with path, line and column", async () => {
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "small"), "needle"));
    const { matches, last } = await drain(sessions, id);
    expect(last.error).toBeNull();
    expect(last.truncated).toBe(false);
    // Each match exactly once (ripgrep is given one path to search).
    expect(matches).toHaveLength(2);
    const byPath = Object.fromEntries(matches.map((m) => [m.path, m]));
    expect(Object.keys(byPath).sort()).toEqual(["a.txt", "sub/b.txt"]);
    expect(byPath["a.txt"]).toMatchObject({ line: 2, column: 7, text: "  the needle is here" });
    expect(byPath["sub/b.txt"]).toMatchObject({ line: 2, column: 9 });
  });

  it("skips .git but still searches other hidden folders", async () => {
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "dotdirs"), "needle"));
    const { matches, last } = await drain(sessions, id);
    expect(last.error).toBeNull();
    expect(matches.map((m) => m.path)).toEqual([".github/y.yml"]);
  });

  it("skips .git also when the include is *", async () => {
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "dotdirs"), "needle", { include: "*" }));
    const { matches, last } = await drain(sessions, id);
    expect(last.error).toBeNull();
    expect(matches.map((m) => m.path)).toEqual([".github/y.yml"]);
  });

  it("applies an exclude the user wrote with a leading !", async () => {
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "small"), "needle", { exclude: "!sub" }));
    const { matches, last } = await drain(sessions, id);
    expect(last.error).toBeNull();
    expect(matches.map((m) => m.path)).toEqual(["a.txt"]);
  });

  it("poll returns only the matches after the cursor", async () => {
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "small"), "needle"));
    const { matches, last } = await drain(sessions, id, 1);
    expect(matches).toHaveLength(1);
    expect(last.cursor).toBe(2);
  });

  it("reports Folder not found for a missing cwd", () => {
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "missing"), "needle"));
    const result = sessions.poll(id, 0);
    expect(result).toMatchObject({ done: true, error: "Folder not found", batch: [] });
  });

  it("reports Folder not found when cwd is a file", () => {
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "small", "a.txt"), "needle"));
    expect(sessions.poll(id, 0)).toMatchObject({ done: true, error: "Folder not found" });
  });

  it("returns ripgrep's message for an invalid regex", async () => {
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "small"), "(", { regex: true }));
    const { last, matches } = await drain(sessions, id);
    expect(matches).toEqual([]);
    expect(last.done).toBe(true);
    expect(last.error).toMatch(/regex parse error/);
  });

  it("treats no matches as success", async () => {
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "small"), "zzzz-not-there"));
    const { last, matches } = await drain(sessions, id);
    expect(matches).toEqual([]);
    expect(last.error).toBeNull();
  });

  it(`stops at ${MAX_MATCHES} matches and kills ripgrep`, async () => {
    spawned = [];
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "many-matches"), "needle"));
    const { last, matches } = await drain(sessions, id);
    expect(matches).toHaveLength(MAX_MATCHES);
    expect(last.truncated).toBe(true);
    expect(last.error).toBeNull();
    expect(spawned).toHaveLength(1);
    expect(exited(spawned[0])).toBe(true);
    expect(spawned[0].killed).toBe(true);
  });

  it(`stops at ${MAX_FILES} files and kills ripgrep`, async () => {
    spawned = [];
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "many-files"), "needle"));
    const { last, matches } = await drain(sessions, id);
    expect(new Set(matches.map((m) => m.path)).size).toBe(MAX_FILES);
    expect(matches).toHaveLength(MAX_FILES);
    expect(last.truncated).toBe(true);
    expect(exited(spawned[0])).toBe(true);
    expect(spawned[0].killed).toBe(true);
  });

  it("a second start for the same cwd ends the first", async () => {
    spawned = [];
    const sessions = makeSessions();
    const cwd = path.join(root, "many-matches");
    const first = sessions.start(options(cwd, "needle"));
    const second = sessions.start(options(cwd, "needle"));
    expect(spawned[0].killed).toBe(true);
    const firstDrained = await drain(sessions, first.id);
    expect(firstDrained.matches).toEqual([]);
    expect(firstDrained.last.done).toBe(true);
    const secondDrained = await drain(sessions, second.id);
    expect(secondDrained.matches).toHaveLength(MAX_MATCHES);
  });

  it("cancel kills ripgrep and the id then expires", async () => {
    spawned = [];
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "many-matches"), "needle"));
    sessions.cancel(id);
    expect(spawned[0].killed).toBe(true);
    await new Promise((resolve) => {
      if (exited(spawned[0])) resolve(undefined);
      else spawned[0].once("exit", resolve);
    });
    expect(sessions.poll(id, 0)).toMatchObject({ done: true, error: "Search expired" });
  });

  it("forgets a session once it has been polled to the end", async () => {
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "small"), "needle"));
    const { last } = await drain(sessions, id);
    expect(last.error).toBeNull();
    expect(sessions.poll(id, last.cursor)).toMatchObject({ done: true, error: "Search expired" });
  });

  it("dispose kills running searches, is idempotent, and leaves polls done", async () => {
    spawned = [];
    const sessions = makeSessions();
    const { id } = sessions.start(options(path.join(root, "many-matches"), "needle"));
    expect(exited(spawned[0])).toBe(false);
    sessions.dispose();
    sessions.dispose();
    expect(spawned[0].killed).toBe(true);
    await new Promise((resolve) => {
      if (exited(spawned[0])) resolve(undefined);
      else spawned[0].once("exit", resolve);
    });
    expect(exited(spawned[0])).toBe(true);
    expect(sessions.poll(id, 0)).toMatchObject({ done: true });
  });
});

// A stand-in for ripgrep that runs until it is killed, so a search stays running.
describe.skipIf(process.platform === "win32")("createSearchSessions limits", () => {
  let root: string;
  let slowRg: string;
  let spawned: ChildProcess[];

  function makeSessions(): SearchSessions {
    return createSearchSessions({ rgPath: slowRg, onSpawn: (child) => spawned.push(child) });
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "irix-content-search-limits-"));
    slowRg = path.join(root, "slow-rg");
    writeFileSync(slowRg, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(slowRg, 0o755);
    for (let i = 0; i <= MAX_RUNNING_SEARCHES; i += 1) mkdirSync(path.join(root, `w${i}`));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it(`stops a search nobody has polled for ${NO_POLL_TIMEOUT_MS / 1000} s`, () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    spawned = [];
    const sessions = makeSessions();
    try {
      const { id } = sessions.start(options(path.join(root, "w0"), "needle"));
      vi.advanceTimersByTime(NO_POLL_TIMEOUT_MS - 1000);
      expect(sessions.poll(id, 0).done).toBe(false);
      // The poll restarted the clock.
      vi.advanceTimersByTime(NO_POLL_TIMEOUT_MS - 1000);
      expect(spawned[0].killed).toBe(false);
      expect(sessions.poll(id, 0).done).toBe(false);
      vi.advanceTimersByTime(NO_POLL_TIMEOUT_MS);
      expect(spawned[0].killed).toBe(true);
      expect(sessions.poll(id, 0)).toMatchObject({
        done: true,
        error: "Search stopped: no client was polling.",
      });
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it(`stops the oldest running search when search ${MAX_RUNNING_SEARCHES + 1} starts`, () => {
    spawned = [];
    const sessions = makeSessions();
    try {
      const ids = Array.from(
        { length: MAX_RUNNING_SEARCHES },
        (_, i) => sessions.start(options(path.join(root, `w${i}`), "needle")).id,
      );
      expect(spawned.map((child) => child.killed)).toEqual(
        Array.from({ length: MAX_RUNNING_SEARCHES }, () => false),
      );
      sessions.start(options(path.join(root, `w${MAX_RUNNING_SEARCHES}`), "needle"));
      expect(spawned.map((child) => child.killed)).toEqual([
        true,
        ...Array.from({ length: MAX_RUNNING_SEARCHES }, () => false),
      ]);
      expect(sessions.poll(ids[0], 0)).toMatchObject({
        done: true,
        error: "Search stopped: too many searches at once.",
      });
      expect(sessions.poll(ids[1], 0).done).toBe(false);
    } finally {
      sessions.dispose();
    }
  });
});
