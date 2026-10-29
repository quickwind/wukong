# Files panel content search, milestone 1 (search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A magnifier in the Files toolbar opens a VS Code-style search of file contents, with streamed results grouped by file, and pressing a match opens the file at that line.

**Architecture:** A new bundled Irix plugin, `plugins/irix-content-search`, runs `rg --json` in the daemon and exposes start/poll/cancel plugin RPCs (the same route the Open folder dialog uses, `invokePluginRpc`), so no protocol message, no `server_info.features` flag and no `messages.ts` edit is needed. The app side is new files under `packages/app/src/irix/`, wired into `file-explorer-pane.tsx` with the smallest possible edit. Replace is milestone 2 and has its own plan.

**Tech Stack:** TypeScript, zod, ripgrep (`rg --json`), vitest, React Native (Expo) for the app.

**Spec:** `docs/superpowers/specs/2026-10-28-files-content-search-design.md` (this plan refines one thing in it: the spec expected protocol messages behind a `server_info.features` flag; plugin RPCs make both unnecessary. Irix ships app and daemon as one set, so presence of the plugin is the gate.)

## Global Constraints

- Irix footprint: new code in new files. Upstream edits only in `packages/app/src/components/file-explorer-pane.tsx`, each line with an `Irix:` marker. Run `node irix/scripts/upstream-footprint.mjs` before committing it. That edit takes the count past the current budget (52 files, 490 lines); Task 8 raises the budget on purpose and says so in IRIX.md.
- Nothing downloaded at install or run time. `rg` is fetched on the packaging machine only (Task 9).
- No shell: spawn `rg` with an argument array (`child_process.spawn`, `shell: false`).
- One search process at a time per workspace directory; a new start kills the previous one.
- At least 2 characters before searching; 100 ms debounce in the app.
- Caps: 500 matches or 100 files, whichever comes first, then `truncated: true` and the process is killed.
- Each returned line is trimmed to at most 240 characters around the first match, with `…` marking a cut end.
- Files ignored by `.gitignore` are not searched, including in folders that are not git repositories; hidden files are searched; binary files are skipped (ripgrep default).
- Regex dialect is ripgrep's (Rust regex). The UI says so next to the toggle.
- Plugin RPC calls time out after 30 s, so streaming is start + poll.
- English strings only (Irix's added strings are not in the translation tables).
- Run `npm run typecheck`, `npm run lint -- <files>` and `npm run format:files -- <files>` after each task. Run only the test files named in each task (`npx vitest run <file> --bail=1`); never the full suite.

## Review Focus

Failure modes the spec implies that no feature step would otherwise test. Each has a test in the task named.

1. An invalid regex (`(`) shows ripgrep's message in the panel and does not crash or leave a spinner (Task 5, Task 6).
2. A minified file with one 2 MB line returns a trimmed line, not 2 MB (Task 4).
3. Typing fast: a slow earlier search must never overwrite the results of a newer query (Task 6).
4. `rg` missing or blocked on the machine shows "Search is not available on this machine" with the reason, not an empty result list (Task 5, Task 6).
5. Windows paths and unusual names: CRLF files, spaces, non-ASCII and `:` in file names come back as workspace-relative forward-slash paths with the right line and UTF-16 column (Task 4).

## File Structure

| File                                                    | Responsibility                                        |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `plugins/irix-content-search/paseo-plugin.json`         | Plugin manifest                                       |
| `plugins/irix-content-search/shared/rpc.ts`             | The three RPC definitions and their zod types         |
| `plugins/irix-content-search/server/rg-binary.ts`       | Finds the bundled `rg`, else `rg` on `PATH`           |
| `plugins/irix-content-search/server/rg-args.ts`         | Pure: search options to the `rg` argument list        |
| `plugins/irix-content-search/server/rg-output.ts`       | Pure: `rg --json` stream to trimmed matches           |
| `plugins/irix-content-search/server/search-sessions.ts` | Spawns `rg`, batches, caps, cancels                   |
| `plugins/irix-content-search/index.server.ts`           | Registers the handlers                                |
| `packages/server/src/irix/plugins.ts`                   | Add the plugin id to `IRIX_BUILTIN_PLUGINS`           |
| `packages/app/src/irix/content-search.ts`               | Client calls (`invokePluginRpc`) with parsed output   |
| `packages/app/src/irix/content-search-state.ts`         | Pure reducer, grouping, debounce and polling rules    |
| `packages/app/src/irix/use-content-search.ts`           | Hook that runs the search loop for one workspace      |
| `packages/app/src/irix/content-search-open.ts`          | Open/closed flag per workspace (external store)       |
| `packages/app/src/irix/content-search-panel.tsx`        | The search area and result list                       |
| `packages/app/src/irix/open-search-match.ts`            | Opens a file at a line                                |
| `packages/app/src/components/file-explorer-pane.tsx`    | Upstream: magnifier button and the tree/search switch |
| `irix/scripts/fetch-ripgrep.mjs`                        | Packaging: pinned download, checksum, extract         |
| `irix/scripts/pack-local.mjs`, `add-license.mjs`        | Packaging: call the fetch, add the license to NOTICE  |

---

### Task 1: Gate, run ripgrep on a company Windows machine (manual)

**Files:** none.

This decides whether bundled `rg` is viable. It runs in parallel with Tasks 2 to 8 (development uses `rg` on `PATH`) and must pass before Task 9.

- [ ] **Step 1: Ask a team member to do this on a company Windows machine without administrator rights**

Download the Windows x64 zip of the pinned ripgrep release (the version Task 9 pins), unzip it to a user folder, then run `rg.exe --version` and `rg.exe -n "TODO" <some project folder>`.

- [ ] **Step 2: Record the result**

Expected: both run and print output. Record the machine, ripgrep version, and result in `paseo-progress activity add`. If either is blocked (application allow-listing, antivirus), stop and go back to the owner: the spec's fallback is `git grep`, which changes the non-git-folder decision.

---

### Task 2: Plugin skeleton and RPC definitions

**Files:**

- Create: `plugins/irix-content-search/paseo-plugin.json`, `plugins/irix-content-search/shared/rpc.ts`, `plugins/irix-content-search/index.server.ts`
- Modify: `packages/server/src/irix/plugins.ts` (add `"irix-content-search"` to `IRIX_BUILTIN_PLUGINS`), `packages/server/src/irix/plugins.test.ts` (list at line 36)

**Interfaces:**

- Produces, in `shared/rpc.ts` (import `defineRpc` and `z` exactly as `plugins/irix-gitlab/shared/rpc.ts` does):

```ts
export const SearchOptionsSchema = z.object({
  cwd: z.string().min(1).max(4096),
  query: z.string().min(2).max(1000),
  caseSensitive: z.boolean(),
  regex: z.boolean(),
  wholeWord: z.boolean(),
  include: z.string().max(1000), // comma-separated globs, "" = all
  exclude: z.string().max(1000),
});
export const MatchSchema = z.object({
  path: z.string(), // relative to cwd, forward slashes
  line: z.number().int().positive(), // 1-based
  column: z.number().int().positive(), // 1-based UTF-16 column of the first match, in the original line
  text: z.string(), // trimmed line
  ranges: z.array(z.object({ start: z.number().int(), end: z.number().int() })), // UTF-16 offsets into `text`
});
export type Match = z.infer<typeof MatchSchema>;
export const startSearchRpc; // "irix.search.content.start":  SearchOptionsSchema -> { id: string }
export const pollSearchRpc; // "irix.search.content.poll":   { id: string, cursor: number } -> { batch: Match[], cursor: number, done: boolean, truncated: boolean, error: string | null }
export const cancelSearchRpc; // "irix.search.content.cancel": { id: string } -> {}
```

- Manifest: `{ "id": "irix-content-search", "name": "Content search", "description": "Searches file contents for the Files panel.", "requirements": { "paseo": ">=0.11.2" } }`.

- [ ] **Step 1: Write the failing test**: in `plugins.test.ts`, expect `IRIX_BUILTIN_PLUGINS` to contain `"irix-content-search"`.
- [ ] **Step 2: Run** `npx vitest run packages/server/src/irix/plugins.test.ts --bail=1`. Expected: FAIL.
- [ ] **Step 3: Create the three plugin files and add the id.** `index.server.ts` default-exports `contribute(server: PluginServerContext)` and registers the three handlers with `server.handle`; the handlers throw `new Error("not implemented")` until Task 5.
- [ ] **Step 4: Run the test again.** Expected: PASS.
- [ ] **Step 5: Typecheck and commit** (`feat(irix): content search plugin skeleton`).

---

### Task 3: Build the `rg` argument list

**Files:**

- Create: `plugins/irix-content-search/server/rg-args.ts`
- Test: `plugins/irix-content-search/server/rg-args.test.ts`

**Interfaces:**

- Consumes: `SearchOptionsSchema` type from Task 2.
- Produces: `export function buildRgArgs(options: Omit<SearchOptions, "cwd">): string[]` (the path argument is `.`; the process runs with `cwd` set).

Behavior pinned by the tests (assert on the full array):

- Always: `--json`, `--hidden`, `--no-require-git`, `--no-config`, `--crlf`. `--max-columns` is not passed (long lines are trimmed in the parser).
- `caseSensitive` true gives `--case-sensitive`, false gives `--ignore-case`.
- Literal search (regex false) adds `--fixed-strings`; `wholeWord` adds `--word-regexp` in both modes.
- The query is always passed as `--regexp <query>`, never as a bare argument, so a query that starts with `-` (test with `-foo`) is not read as a flag.
- `include` "src/**, \*.ts" becomes `-g src/**`and`-g \*.ts`(split on commas, trimmed, empties dropped).`exclude`entries become`-g !<glob>`.
- `--glob-case-insensitive` is not passed.

- [ ] **Step 1: Write the failing tests** for each bullet above, with names like `"puts a query that starts with a dash after --regexp"`.
- [ ] **Step 2: Run** `npx vitest run plugins/irix-content-search/server/rg-args.test.ts --bail=1`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `buildRgArgs`.**
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(irix): ripgrep argument builder`).

---

### Task 4: Parse `rg --json` output into trimmed matches

**Files:**

- Create: `plugins/irix-content-search/server/rg-output.ts`
- Test: `plugins/irix-content-search/server/rg-output.test.ts`

**Interfaces:**

- Consumes: `Match` from Task 2.
- Produces:

```ts
export const LINE_WINDOW = 240;
export interface RgOutputParser {
  push(chunk: Buffer | string): Match[]; // matches completed by this chunk
  end(): Match[]; // flush a trailing partial line
}
export function createRgOutputParser(): RgOutputParser;
export function trimLineAroundMatch(
  line: string, // line without its terminator
  ranges: { start: number; end: number }[], // UTF-16 offsets in `line`
): { text: string; ranges: { start: number; end: number }[] };
```

Behavior pinned by the tests (feed fixtures captured from a real `rg --json` run; keep them as string constants in the test):

- Only `"type":"match"` messages produce output; `begin`, `end`, `context` and `summary` are ignored.
- A JSON line split across two `push` calls, and a multi-byte character split across two chunks, parse correctly (use `StringDecoder`).
- `submatches[].start/end` are UTF-8 byte offsets; convert to UTF-16 offsets. A line with `日本語` before the match gives the right range and `column`.
- `lines.bytes` (base64, a non-UTF-8 line) is decoded lossily and does not throw.
- `path.text` becomes the `path` field with backslashes replaced by `/` and any leading `./` removed; a name with spaces, non-ASCII and `:` survives.
- The CRLF terminator is not in `text`.
- `trimLineAroundMatch`: a line of 2,000,000 characters with a match at the end returns `text.length <= LINE_WINDOW + 2` (the `…` markers) and ranges that still point at the matched text; a short line is returned unchanged.
- A malformed JSON line is skipped (it cannot crash a running search); `end()` returns nothing for an empty remainder.

- [ ] **Step 1: Write the failing tests** for each bullet.
- [ ] **Step 2: Run** `npx vitest run plugins/irix-content-search/server/rg-output.test.ts --bail=1`. Expected: FAIL.
- [ ] **Step 3: Implement both functions.** Convert byte offsets by decoding `Buffer.from(lineBytes).subarray(0, byteOffset)` to a string and taking its length.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** (`feat(irix): ripgrep output parser`).

---

### Task 5: Run searches: binary lookup, sessions, batching, caps, cancel

**Files:**

- Create: `plugins/irix-content-search/server/rg-binary.ts`, `plugins/irix-content-search/server/search-sessions.ts`
- Modify: `plugins/irix-content-search/index.server.ts` (replace the stubs)
- Test: `plugins/irix-content-search/server/rg-binary.test.ts`, `plugins/irix-content-search/server/search-sessions.test.ts`

**Interfaces:**

- Consumes: `buildRgArgs` (Task 3), `createRgOutputParser` (Task 4), RPC types (Task 2).
- Produces:

```ts
// rg-binary.ts
export function resolveRgBinary(options?: {
  pluginDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  pathEnv?: string;
  exists?: (p: string) => boolean;
}): string | null;
// bundled: <pluginDir>/vendor/<platform>-<arch>/rg(.exe), else first `rg(.exe)` on PATH, else null

// search-sessions.ts
export const MAX_MATCHES = 500;
export const MAX_FILES = 100;
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
}
export function createSearchSessions(deps?: { rgPath?: string | null }): SearchSessions;
```

Behavior pinned by the tests (use a temporary folder with real files and a real `rg`; skip the file with `describe.skipIf(!resolveRgBinary())` and say so in the test title):

- `resolveRgBinary` prefers the bundled path when it exists, uses `PATH` otherwise, and returns `null` when neither exists (inject `exists`/`pathEnv`; Windows adds `.exe`).
- A literal search finds a matching line with the right path, line and column; poll with `cursor` returns only matches after it, and `done` becomes true.
- `cwd` that is not an existing directory yields `error` "Folder not found", not a throw.
- No `rg` (`rgPath: null`) gives `done: true`, `error` starting "Search is not available on this machine".
- Invalid regex `(` with `regex: true` gives `error` containing ripgrep's message and `done: true`.
- More than `MAX_MATCHES` matches stops at `MAX_MATCHES` with `truncated: true` and the child process killed (assert it exits); same for `MAX_FILES`.
- A second `start` for the same `cwd` kills the first; polling the first afterward returns `done: true` with no further matches.
- `cancel` kills the process; polling an unknown id returns `done: true, error: "Search expired"`.
- A finished session is forgotten after being polled to the end, or after 60 s.

- [ ] **Step 1: Write the failing tests** for `rg-binary` and `search-sessions`.
- [ ] **Step 2: Run** both files with `npx vitest run <file> --bail=1`. Expected: FAIL.
- [ ] **Step 3: Implement.** `spawn(rg, [...buildRgArgs(options), "."], { cwd, shell: false, windowsHide: true })`; feed stdout to the parser; keep a growing array of matches per session; kill on cap, cancel or replace; collect stderr (cap 10 KB) for the `error` text when the exit code is 2. Exit code 1 (no matches) is not an error.
- [ ] **Step 4: Register the handlers in `index.server.ts`**: create one `SearchSessions` per plugin load, with `resolveRgBinary({ pluginDir })`. Before `start`, check that `cwd` is absolute; also verify it is a known workspace directory through the plugin host API that `plugins` already use to list workspaces (find the call by reading how `paseo-workboard` or `plugins/irix-gitlab` read workspaces; if the plugin context cannot, say so in the commit message and rely on the daemon's authentication).
- [ ] **Step 5: Run the tests again.** Expected: PASS.
- [ ] **Step 6: Commit** (`feat(irix): ripgrep search sessions`).

---

### Task 6: App-side search state and client

**Files:**

- Create: `packages/app/src/irix/content-search.ts`, `packages/app/src/irix/content-search-state.ts`, `packages/app/src/irix/use-content-search.ts`
- Test: `packages/app/src/irix/content-search.test.ts`, `packages/app/src/irix/content-search-state.test.ts`

**Interfaces:**

- Consumes: the three RPC names and schemas from Task 2 (duplicate the zod schemas in `content-search.ts`, the way `folder-picker.ts` duplicates `irix-gitlab`'s; a plugin bundle cannot be imported from the app).
- Produces:

```ts
// content-search.ts
export interface ContentSearchClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}
export function startSearch(client: ContentSearchClient, options: SearchOptions): Promise<string>;
export function pollSearch(
  client: ContentSearchClient,
  id: string,
  cursor: number,
): Promise<PollResult>;
export function cancelSearch(client: ContentSearchClient, id: string): Promise<void>;

// content-search-state.ts
export const MIN_QUERY_LENGTH = 2;
export const DEBOUNCE_MS = 100;
export const POLL_INTERVAL_MS = 150;
export interface FileGroup {
  path: string;
  matches: Match[];
}
export interface SearchState {
  requestKey: string;
  status: "idle" | "searching" | "done" | "error";
  groups: FileGroup[];
  matchCount: number;
  truncated: boolean;
  error: string | null;
}
export type SearchAction =
  | { type: "reset"; requestKey: string }
  | { type: "batch"; requestKey: string; batch: Match[]; done: boolean; truncated: boolean }
  | { type: "failed"; requestKey: string; message: string };
export function reduceSearch(state: SearchState, action: SearchAction): SearchState;
export function shouldSearch(query: string): boolean; // trimmed length >= MIN_QUERY_LENGTH

// use-content-search.ts
export function useContentSearch(input: {
  client: ContentSearchClient | null;
  cwd: string | null;
  options: Omit<SearchOptions, "cwd">;
}): SearchState;
```

Behavior pinned by the tests:

- `reduceSearch` ignores any action whose `requestKey` differs from `state.requestKey` (a slow old search cannot overwrite a newer one), groups matches by `path` in arrival order, and sets `status` "done" only when `done` is true.
- `shouldSearch("a")` false, `shouldSearch(" ab ")` true.
- `content-search.ts` rejects output that does not match the schema (a malformed answer is an error, not silent).
- A rejected `invokePluginRpc` (plugin absent on an older host) becomes `failed` with "Search is not available on this host. Update the host."
- `useContentSearch` changing the query cancels the running search (`cancelSearch`) before starting, waits `DEBOUNCE_MS`, then polls every `POLL_INTERVAL_MS` until `done`; unmounting cancels. Test the loop with fake timers and a fake client, in a hook test file named `use-content-search.test.tsx` using the repo's existing hook-test pattern.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** each file with `npx vitest run <file> --bail=1`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Typecheck and commit** (`feat(irix): content search client and state`).

---

### Task 7: Search panel UI and open-match

**Files:**

- Create: `packages/app/src/irix/content-search-open.ts`, `packages/app/src/irix/open-search-match.ts`, `packages/app/src/irix/content-search-panel.tsx`
- Test: `packages/app/src/irix/content-search-open.test.ts`, `packages/app/src/irix/open-search-match.test.ts`, `packages/app/src/irix/content-search-panel.test.tsx`

**Interfaces:**

- Consumes: `useContentSearch`, `SearchState`, `Match` (Task 6); `createWorkspaceFileTabTarget` and `normalizeWorkspaceFileLocation` from `@/workspace/file-open`; the same open arguments `openWorkspaceFileFromExplorer` takes (`packages/app/src/screens/workspace/workspace-file-open-command.ts`).
- Produces:

```ts
// content-search-open.ts: external store (useSyncExternalStore), keyed by `${serverId}:${workspaceId}`
export function useContentSearchOpen(key: string): boolean;
export function toggleContentSearch(key: string): void;

// open-search-match.ts
export function openSearchMatch(input: { match: Match; persistenceKey: string | null; openWorkspaceTabInFocusedPane: ...; revealWorkspaceTab: ... }): void;
// opens match.path at lineStart = match.line, same placement as openWorkspaceFileFromExplorer

// content-search-panel.tsx
export function IrixContentSearchPanel(props: { serverId: string; workspaceId: string | null; cwd: string; onOpenMatch: (match: Match) => void }): ReactElement;
```

UI (follow `docs/design.md`; use the styles the Files pane already uses; no `useUnistyles()` per `docs/unistyles.md`): a query input; three toggle buttons labeled "Aa" (match case), ".\*" (regular expression, with the hint "Rust regex syntax"), and "ab" (whole word); a collapsed "files to include / exclude" pair of inputs; below, results grouped by file (file name, folder muted, match count), each match row showing the trimmed line with `ranges` highlighted; a "Results are limited. Narrow the search." line when `truncated`; states for idle ("Type at least 2 characters"), searching, no results, and error.

Behavior pinned by the tests:

- `toggleContentSearch` flips only its own key; the store survives the pane unmounting.
- `openSearchMatch` calls `openWorkspaceTabInFocusedPane` with a file target whose `lineStart` is the match line, then reveals the tab; does nothing without a `persistenceKey`.
- Panel test (rendered with a fake `useContentSearch` result): shows grouped files, highlights the range, calls `onOpenMatch` with the match when a row is pressed, shows the truncation line, and shows the error text for `status: "error"`.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** each with `npx vitest run <file> --bail=1`. Expected: FAIL.
- [ ] **Step 3: Implement** the store, the opener and the panel.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Format, lint, typecheck, commit** (`feat(irix): content search panel`).

---

### Task 8: Wire the Files panel, raise the footprint budget, check it in a real browser

**Files:**

- Modify: `packages/app/src/components/file-explorer-pane.tsx` (toolbar near line 1236, the body where the tree is rendered), `irix/scripts/upstream-footprint.mjs` (defaults), `IRIX.md` (budget numbers, upstream-files table row, plugins row, a short design-decision paragraph for content search)

**Interfaces:**

- Consumes: `IRIX_BUILD` from `packages/app/src/irix/build.ts`; `useContentSearchOpen`, `toggleContentSearch` (Task 7); `IrixContentSearchPanel` (Task 7); the `Search` icon from `lucide-react-native`.

The edit, kept to a handful of lines, each with `// Irix:`:

- A `ToolbarButton` with `testID="files-search"`, `label="Search in files"`, `selected` while open, placed right after the `files-new-folder` button in the same `ToolbarControls`, only when `IRIX_BUILD` is true (the new-file and new-folder buttons only render when `onNewEntryAtRoot` is set; the magnifier does not depend on it), calling `toggleContentSearch(key)`.
- Where the tree body renders: when `IRIX_BUILD` and the search is open, render `IrixContentSearchPanel` instead of the tree. Follow IRIX.md's ladder: if the formatter re-indents the tree block, undo and wrap the tree in a tiny Irix component or hide it with a one-line style instead of moving code.

- [ ] **Step 1: Write the failing test**: a render test (beside the existing `file-explorer-pane` tests; find them with `rg -l "file-explorer-pane" packages/app/src --glob '*.test.*'`) that, with `IRIX_BUILD` on, shows `files-search`, and pressing it replaces the tree with the search panel; pressing again restores the tree; with `IRIX_BUILD` off nothing changes (upstream behavior byte-for-byte).
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Make the edit.**
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Raise the budget on purpose.** `node irix/scripts/upstream-footprint.mjs` will now report 53 files; set the defaults in `irix/scripts/upstream-footprint.mjs` to the new measured numbers plus no slack, and update the sentence in `IRIX.md` that gives the budget and what used the room. Add `file-explorer-pane.tsx` to the upstream-files table and the plugin to the "Where Irix lives" table.
- [ ] **Step 6: Check in a real browser** (IRIX.md: mocked tests hide real bugs). Start a dev daemon on another port in a temp home, open the web UI, open a workspace, press the magnifier, type a word, confirm results stream and a click opens the file at the line; try an invalid regex, a one-character query, and a workspace with 5,000+ files. Save screenshots under `out/` (`feedback_test-screenshots-in-out-dir`).
- [ ] **Step 7: Run** `node irix/scripts/upstream-footprint.mjs`, then `npm run typecheck`, lint and format on the touched files. Expected: all pass.
- [ ] **Step 8: Commit** (`feat(irix): search button in the Files panel`).

---

### Task 9: Bundle ripgrep (blocked on Task 1)

**Files:**

- Create: `irix/scripts/fetch-ripgrep.mjs`
- Test: `irix/scripts/fetch-ripgrep.test.mjs` (follow how other `irix/scripts/*.mjs` are tested, if they are; otherwise test the pure parts inline)
- Modify: `irix/scripts/pack-local.mjs` (call the fetch in the throwaway checkout after the brand step, near line 217), `irix/scripts/add-license.mjs` (add ripgrep's license to the `NOTICE`), `IRIX.md` (packaging section), `irix/README.md` if it lists what the tarballs contain

**Interfaces:**

- Produces: `export const RIPGREP_VERSION: string; export const RIPGREP_ASSETS: Record<string, { file: string; sha256: string }>` keyed by `"<platform>-<arch>"` (at least `win32-x64`; also `darwin-arm64` and `linux-x64` for the people who build or test on them); `export async function fetchRipgrep(destRoot: string, targets?: string[]): Promise<void>` that downloads each asset, verifies the SHA-256, extracts the executable to `<destRoot>/vendor/<platform>-<arch>/rg` or `rg.exe`, and refuses on a checksum mismatch.

- [ ] **Step 1: Pin the version.** Use the ripgrep release the team verified in Task 1; read each asset's `.sha256` from the release page and write the values into `RIPGREP_ASSETS`.
- [ ] **Step 2: Write the failing tests** for the pure parts: a checksum mismatch throws and leaves nothing in `destRoot`; an unknown platform key throws a clear message; the extracted layout is `vendor/<platform>-<arch>/rg(.exe)`.
- [ ] **Step 3: Run it.** Expected: FAIL.
- [ ] **Step 4: Implement `fetch-ripgrep.mjs`** (download with the Node `https` module; the packaging machine is online, the installed daemon never runs this).
- [ ] **Step 5: Call it from `pack-local.mjs`** with `destRoot` set to `plugins/irix-content-search` inside the throwaway checkout, so the binary is never committed and `plugins/` is copied into `dist/server/builtin-plugins` by the existing server build step. Add ripgrep's license text to the `NOTICE` that `add-license.mjs` writes.
- [ ] **Step 6: Run `node irix/scripts/license-audit.mjs`.** Expected: ripgrep is listed as permissive (MIT/Unlicense). Name the source and license in the commit message.
- [ ] **Step 7: Pack and smoke-test** (IRIX.md: a finished background task does not mean success): `node irix/scripts/pack-local.mjs --out <temp dir>`, install the tarballs into a temp prefix, start the daemon on another port, and confirm a search works with no `rg` on `PATH`. On Windows, repeat on a clean machine.
- [ ] **Step 8: Commit** (`feat(irix): ship ripgrep for content search`).

---

## Self-review notes

- Spec coverage: magnifier and toggle (Task 8); query, three toggles, include/exclude (Tasks 3, 7); grouped streaming results and jump to line (Tasks 5 to 7); cancel and limits (Task 5); any folder, git or not (Task 3 `--no-require-git`); Irix footprint and budget (Task 8); bundling, license and NOTICE (Task 9); first prerequisite (Task 1). Replace, unsaved-edit detection and the conflict rules belong to milestone 2 and are not in this plan. Searching open editors is a non-goal.
- Types: `Match`, `SearchOptions`, `PollResult` are defined once in Task 2/5 and reused with the same names in Tasks 5 to 7.
- Open points for the builder: the exact plugin host call for workspace directories (Task 5 Step 4), the existing test pattern for the Files pane (Task 8 Step 1), and the `fetch-ripgrep` test location (Task 9).
