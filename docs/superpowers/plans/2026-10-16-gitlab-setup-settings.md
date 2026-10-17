# GitLab Setup Settings Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Settings → Plugins → GitLab screen that checks the python-gitlab tooling, picks or creates a python-gitlab config section, tests it on demand, and writes `irix.json`.

**Architecture:** All work lives in the bundled plugin `plugins/irix-gitlab/`. The daemon side (`server/setup/*`) reads and writes `~/.python-gitlab.cfg` and `<home>/irix.json` and shells out to the `gitlab` command; the client side is one settings screen registered with `client.addSettingsScreen`. The daemon's forge adapter (`packages/server/src/irix/gitlab/adapter.ts`) is not touched.

**Tech Stack:** TypeScript, zod, vitest, `@getpaseo/plugin` (`defineRpc`, `@getpaseo/plugin/client/ui` settings components, `openExternalUrl`), python-gitlab 8.x CLI.

**Spec:** No separate design document. The agreed design is the "Design" section below, taken from the brainstorming conversation of 2026-10-16.

## Design (agreed with the user)

- Tooling check: `gitlab` command missing → every other control disabled, the page shows `uv tool install python-gitlab` and, if `uv` is also missing, the uv install pointer. Irix never runs the installer.
- `~/.python-gitlab.cfg` exists → list its sections (excluding `global`) in a dropdown. Each entry shows an outcome from an explicit **Test** button: `ok`, `unreachable`, `token-rejected`; `ok` also names missing token scopes. Nothing is tested when the page opens.
- Selecting a section writes `gitlab.configSection` and `gitlab.url` (the section's `url`) to `irix.json`. The URL is read-only on the screen; changing it means choosing or creating another section.
- No cfg → form: GitLab URL → **Get token** (opens the prefilled token page in the default browser) → token field → Create. The section is written to the cfg only if a test with that token succeeds.
- Token page: `<url>/-/user_settings/personal_access_tokens?name=Irix&description=Irix+GitLab+access&scopes=api,read_repository,write_repository`. GitLab cannot prefill the expiry (verified by the user: the prefill works on the company GitLab 19.0). Instruction text: pick the longest expiry the page allows (this company's default is 30 days), click **Generate token**, copy the token back here.
- A rejected token (401) or a token expiring within 14 days (only known when the **Test** button runs) shows a banner with **Generate a new token**, which opens the same prefilled page and, on paste, replaces only that section's `private_token`.
- Last field: `cloneRoot` (absolute path or `~/...`), written to `irix.json`.
- Token handling: it passes through one RPC, is never logged or stored by Irix, and ends up only in the cfg file, mode 0600. It is never placed on argv.
- When `IRIX_GITLAB_URL`, `IRIX_GITLAB_SECTION`, `IRIX_GITLAB_COMMAND` or `IRIX_CLONE_ROOT` is set, the screen says that variable overrides the saved value.
- The daemon's forge adapter reads `irix.json` once at startup, so merge-request features pick up a changed section or URL after a daemon restart. The screen says so after saving. The plugin's own features (project search, clone) read the file per call and update immediately.
- Not in scope: OAuth, running installers, background token polling, popups, editing or deleting existing cfg sections, a changed daemon adapter.

## Global Constraints

- `gitlab.url` must be https, with no credentials, query string or fragment (same rule as `packages/server/src/irix/gitlab/config.ts`).
- Plugin bundle code cannot import daemon modules; share nothing with `packages/server`.
- RPC names use the existing `irix.gitlab.*` family with dotted segments: `irix.gitlab.setup.<operation>`.
- The token never appears on a command line, in a log line, in an error message or in an RPC output.
- A leading `@` in any value passed to the `gitlab` CLI is doubled (`cliValue` in `server/gitlab.ts`); reuse it.
- Run only the changed test files: `npx vitest run <file> --bail=1`. After every task: `npm run typecheck:server` and `npm run lint -- <changed files>`; `npm run format:files -- <changed files>` before committing.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Token with a newline, `=`, leading/trailing spaces or a `@` prefix: rejected or neutralised, never able to inject a cfg line or read a file.
- Cfg that has comments, CRLF line endings, a BOM, unrelated sections and `helper:` credential entries: everything outside the edited section survives unchanged and sections without `private_token` still list and test normally.
- `irix.json` that is malformed JSON or holds other top-level keys: malformed → error and no overwrite; other keys preserved on write.
- Section whose `url` is missing or not https: listed as unusable, not selectable.
- Offline or DNS failure versus 401 versus a healthy server: three different results, and only 401 says "token".
- A new section name colliding with an existing one, or equal to `global`: a free name is chosen.
- Environment variable override active: the screen shows which one and that the saved value is not in effect.
- Windows: the cfg path is `%USERPROFILE%\.python-gitlab.cfg`, `chmod` failure is ignored.
- Expiry lookup unavailable on an older GitLab or python-gitlab: the test still succeeds without an expiry warning.

---

### Task 1: python-gitlab cfg file reader/writer

**Files:**

- Create: `plugins/irix-gitlab/server/setup/cfg-file.ts`
- Test: `plugins/irix-gitlab/server/setup/cfg-file.test.ts`

**Interfaces:**

- Produces:
  - `cfgPath(env?: NodeJS.ProcessEnv): string` — `PYTHON_GITLAB_CFG` if set, else `~/.python-gitlab.cfg`.
  - `interface CfgSection { name: string; url: string | null }`
  - `readCfgSections(path: string): CfgSection[]` — `[]` when the file is absent; excludes `global` and `[global]`-less keys.
  - `upsertSection(path: string, section: { name: string; url: string; token: string }): void` — creates the file (0600) when absent, adds `[global]\ndefault = <name>` only when the file has no `[global]`, replaces an existing section's `url`/`private_token`/`api_version` lines only, leaves every other byte alone, writes via temp file + rename.
  - `freeSectionName(existing: string[], base?: string): string` — `irix`, `irix-2`, …, never `global`.
  - `assertCfgValue(label: string, value: string): void` — throws on empty, control characters or leading/trailing whitespace.

- [ ] **Step 1: Write failing tests** in `cfg-file.test.ts` using a temp dir: `readCfgSections` returns names and urls of a two-section cfg and ignores `[global]`; a section with `private_token = helper: pass show gitlab` lists normally; CRLF + BOM + comments round-trip through `upsertSection` untouched outside the edited section; a new file is created with mode 0600 (skip the mode assertion on win32) and contains `[global]`, `default = irix`, `api_version = 4`; an existing `[global]` is not modified; `assertCfgValue("token", "a\nb")` and `" x"` throw; `freeSectionName(["irix","global"])` is `irix-2`.
- [ ] **Step 2: Run** `npx vitest run plugins/irix-gitlab/server/setup/cfg-file.test.ts --bail=1` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the functions above in `cfg-file.ts` with a line-based parser (section = line matching `^\s*\[([^\]]+)\]\s*$`), no INI library.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(irix-gitlab): read and write the python-gitlab config file`.

### Task 2: irix.json read/write

**Files:**

- Create: `plugins/irix-gitlab/server/setup/irix-json.ts`
- Test: `plugins/irix-gitlab/server/setup/irix-json.test.ts`

**Interfaces:**

- Consumes: `expandHome`, `resolve` logic from `server/config.ts` (paseo home = `PASEO_HOME` or `~/.paseo`).
- Produces:
  - `irixJsonPath(env?: NodeJS.ProcessEnv): string`
  - `readGitLabSaved(env?: NodeJS.ProcessEnv): { url: string | null; configSection: string | null; cloneRoot: string | null }`
  - `writeGitLabSaved(patch: { url?: string; configSection?: string; cloneRoot?: string }, env?: NodeJS.ProcessEnv): void` — read-modify-write, keeps other `gitlab.*` keys and other top-level keys, atomic rename, creates the home directory if needed, throws `Cannot read <path>: …` on malformed JSON without writing.

- [ ] **Step 1: Write failing tests**: write into an empty home creates the file; existing `{"gitlab":{"sshHost":"h"},"other":1}` keeps `sshHost` and `other`; malformed JSON throws and leaves the file byte-identical; BOM tolerated; `cloneRoot` stored as given (`~/projects` is not expanded).
- [ ] **Step 2: Run** `npx vitest run plugins/irix-gitlab/server/setup/irix-json.test.ts --bail=1` — expect FAIL.
- [ ] **Step 3: Implement** in `irix-json.ts`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(irix-gitlab): save GitLab setup to irix.json`.

### Task 3: Tool check and section test

**Files:**

- Create: `plugins/irix-gitlab/server/setup/probe.ts`
- Test: `plugins/irix-gitlab/server/setup/probe.test.ts`

**Interfaces:**

- Consumes: `GitLabSettings.command` shape (`string[]`) from `server/config.ts`; `cliValue` is not needed because no user text reaches argv except the section name, which `cfg-file` already restricted to `^[^\s-]\S*$`.
- Produces:
  - `type ToolStatus = { gitlab: { found: boolean; version: string | null }; uv: { found: boolean } }`
  - `checkTools(command: string[]): Promise<ToolStatus>` — runs `<command> --version` and `uv --version`; ENOENT → `found: false`.
  - `type SectionTest = { result: "ok"; expiresAt: string | null; missingScopes: string[] } | { result: "unreachable"; detail: string } | { result: "token-rejected"; detail: string }`
  - `testSection(command: string[], section: string, env?: NodeJS.ProcessEnv): Promise<SectionTest>` — runs `<command> --output=json --gitlab=<section> personal-access-token get --id=self`; the answer's `expires_at` and `scopes` fill `expiresAt` and `missingScopes` (required: `api`, `read_repository`, `write_repository`). HTTP 401 → `token-rejected`; a network failure (DNS, ECONNREFUSED, timeout, TLS) → `unreachable`; any other failure (the token is not a personal access token, an older GitLab) → retry once with `current-user get`, which gives `ok` with `expiresAt: null` and `missingScopes: []`, or a classified failure. `detail` never contains the token (strip any `private_token` substring defensively).
  - `testToken(command: string[], url: string, token: string): Promise<SectionTest>` — same logic with the token passed through `GITLAB_PRIVATE_TOKEN` and `--server-url=<url>`, no section, for use before writing the cfg.
  - `expiresSoon(expiresAt: string | null, now: Date, days = 14): boolean`

- [ ] **Step 1: Write failing tests** with a fake `gitlab` executable script in a temp dir (same technique as `server/projects.test.ts`): `self` answer → `ok` with expiry and scopes (a token lacking `write_repository` lists it in `missingScopes`); `Impossible to get (401: 401 Unauthorized)` → `token-rejected`; `getaddrinfo ENOTFOUND` → `unreachable`; missing executable → `checkTools` reports `found: false`; `self` failing with 404 falls back to `current-user get` and returns `ok` with `expiresAt: null`; `expiresSoon` true for 13 days, false for 15 days and for `null`; the fake records its env and argv, and the test asserts the token is in env only.
- [ ] **Step 2: Run** `npx vitest run plugins/irix-gitlab/server/setup/probe.test.ts --bail=1` — expect FAIL.
- [ ] **Step 3: Implement** in `probe.ts`; reuse the `run`-style `execFile` helper pattern from `server/gitlab.ts` (export a shared `run` from there if it is not exported yet) with a 15 s timeout.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Verify the real CLI shape** against python-gitlab 8.x if installed (`gitlab personal-access-token get --id=self`); if it does not work, the fallback path is the only path and the final report says so.
- [ ] **Step 6: Commit** `feat(irix-gitlab): probe the gitlab tooling and test a config section`.

### Task 4: Setup RPCs and handlers

**Files:**

- Modify: `plugins/irix-gitlab/shared/rpc.ts` (append), `plugins/irix-gitlab/index.server.ts`
- Create: `plugins/irix-gitlab/server/setup/handlers.ts`
- Test: `plugins/irix-gitlab/server/setup/handlers.test.ts`

**Interfaces:**

- Consumes: Tasks 1–3 exports.
- Produces, in `shared/rpc.ts`:
  - `setupStatusRpc` (`irix.gitlab.setup.status`): input `{}`; output `{ tools: ToolStatus; cfgPath: string; sections: { name: string; url: string | null; usable: boolean }[]; saved: { url: string | null; configSection: string | null; cloneRoot: string | null }; overrides: ("IRIX_GITLAB_URL" | "IRIX_GITLAB_SECTION" | "IRIX_GITLAB_COMMAND" | "IRIX_CLONE_ROOT")[] }`. `usable` is true only for https urls.
  - `setupTestSectionRpc` (`irix.gitlab.setup.test-section`): input `{ section: string }`; output is `SectionTest` plus `expiresSoon: boolean`.
  - `setupCreateSectionRpc` (`irix.gitlab.setup.create-section`): input `{ url: string; token: string; replaceSection?: string }`; output `{ section: string }`. Validates url (https rule) and token (`assertCfgValue`), runs `testToken`, writes the cfg only on `ok`, otherwise throws with the result's text. `replaceSection` updates that section's token and keeps its url.
  - `setupSaveRpc` (`irix.gitlab.setup.save`): input `{ section: string; cloneRoot: string }`; output `{ url: string; restartNeeded: boolean }`. Takes `url` from the cfg section (never from the client), rejects an unknown or non-https section, requires `cloneRoot` to be absolute or `~/…`, writes the three keys, `restartNeeded` is true when `configSection` or `url` changed.
- All four are registered in `index.server.ts` with `server.handle`.

- [ ] **Step 1: Write failing tests** with temp `HOME`/`PASEO_HOME`/`PYTHON_GITLAB_CFG` and the fake `gitlab`: status lists sections and reports `IRIX_GITLAB_SECTION` as an override when set; create-section writes nothing when the token is rejected and writes section `irix` plus a 0600 file when accepted; `replaceSection` changes only that token; save writes `url` from the cfg and rejects a client-supplied url mismatch by ignoring it; save with a relative `cloneRoot` throws; the token string never appears in any returned value or in captured `console` output.
- [ ] **Step 2: Run** `npx vitest run plugins/irix-gitlab/server/setup/handlers.test.ts --bail=1` — expect FAIL.
- [ ] **Step 3: Implement** `handlers.ts` (one exported function per RPC, `loadSettings`-style env injection for tests) and register them in `index.server.ts`.
- [ ] **Step 4: Run** the handler tests and `npx vitest run packages/server/src/irix/gitlab-plugin.test.ts --bail=1` — expect PASS.
- [ ] **Step 5: Commit** `feat(irix-gitlab): setup RPCs for status, test, create and save`.

### Task 5: Settings screen

**Files:**

- Create: `plugins/irix-gitlab/shared/token-url.ts`, `plugins/irix-gitlab/client/setup-screen.tsx`
- Modify: `plugins/irix-gitlab/index.client.tsx`
- Test: `plugins/irix-gitlab/shared/token-url.test.ts`, `plugins/irix-gitlab/client/setup-screen.test.tsx`

**Interfaces:**

- Consumes: the four RPCs from Task 4; `openExternalUrl` from `@getpaseo/plugin/client`; `SettingsSection`, `SettingsCard`, `SettingsRow`, `SettingsSelect`, `SettingsInput`, `SettingsAction` from `@getpaseo/plugin/client/ui`.
- Produces:
  - `tokenPageUrl(baseUrl: string): string` — `<baseUrl without trailing slash>/-/user_settings/personal_access_tokens?name=Irix&description=Irix+GitLab+access&scopes=api,read_repository,write_repository`.
  - `GitLabSetupScreen` component, registered as `client.addSettingsScreen({ id: "gitlab", title: "GitLab", icon: "GitBranch", Component: GitLabSetupScreen })`.

Screen behaviour (one block each, top to bottom):

1. Tools: if `tools.gitlab.found` is false, show the install commands and disable every later block.
2. Section: `SettingsSelect` of usable sections, a read-only row with the section's url, a **Test** action that calls `setupTestSectionRpc` and shows `ok`, with a warning listing `missingScopes`, `unreachable: <detail>` or `token rejected`, plus an expiry warning when `expiresSoon`.
3. Token banner (after a test shows `token-rejected` or `expiresSoon`): **Generate a new token** opens `tokenPageUrl(section url)`, then a token field and **Save token** calling `setupCreateSectionRpc` with `replaceSection`.
4. New section (shown when there are no sections, or via **Add another section**): url field, **Get token** (opens `tokenPageUrl`), instruction text from the Design section, token field, **Create**.
5. Clone root field and **Save** calling `setupSaveRpc`; success text says "Merge-request features use the new GitLab after the daemon restarts" when `restartNeeded`.
6. Overrides: each name in `overrides` shows "`<NAME>` is set and overrides the saved value".

- [ ] **Step 1: Write failing tests**: `tokenPageUrl("https://gl.example.com/")` equals the exact URL in the Design section; `tokenPageUrl` does not double a slash. Screen tests (render with the repo's existing client test setup used by `client/devin-desktop-button.test.tsx`) with mocked RPC results: missing tool disables the rest and shows the install command; **Test** is not called on mount; a `token-rejected` result shows the new-token banner; Create with a token calls `setupCreateSectionRpc` once and never renders the token string afterwards; the url row is not an input once a section is selected.
- [ ] **Step 2: Run** `npx vitest run plugins/irix-gitlab/shared/token-url.test.ts plugins/irix-gitlab/client/setup-screen.test.tsx --bail=1` — expect FAIL.
- [ ] **Step 3: Implement** `token-url.ts`, `setup-screen.tsx` and the registration in `index.client.tsx`; keep the screen in React state only, no new store.
- [ ] **Step 4: Run** the same command — expect PASS; then `npm run typecheck:server` and `npm run lint -- plugins/irix-gitlab`.
- [ ] **Step 5: Commit** `feat(irix-gitlab): GitLab setup screen in plugin settings`.

### Task 6: Point search errors at the settings screen

**Files:**

- Modify: `plugins/irix-gitlab/client/screen.tsx` (error rendering around the search failure state)
- Test: add a case to `plugins/irix-gitlab/client/setup-screen.test.tsx` or a new `client/screen-error.test.tsx`

**Interfaces:**

- Consumes: `client.openSettings("gitlab")` (the screen reaches it through the surface props or `usePaseo`; check `PluginSurfaceProps` in `packages/plugin/src/client` for the available handle).
- Produces: when search fails with text matching `/not configured|401|unauthorized|not found; install/i`, the error area adds an **Open GitLab settings** button that opens the Task 5 screen.

- [ ] **Step 1: Write the failing test**: a rejected search with `GitLab is not configured…` renders the button; an unrelated error does not.
- [ ] **Step 2: Run** `npx vitest run plugins/irix-gitlab/client --bail=1` — expect FAIL.
- [ ] **Step 3: Implement** the button in `screen.tsx` using the settings-opening handle named in the Consumes line above.
- [ ] **Step 4: Run** the same command — expect PASS; `npm run typecheck:server`, `npm run lint -- plugins/irix-gitlab`.
- [ ] **Step 5: Commit** `feat(irix-gitlab): link GitLab search errors to the setup screen`.

### Task 7: Docs

**Files:**

- Modify: `irix/README.md` (GitLab section), `IRIX.md` (the `plugins/irix-gitlab/` row and the Add project bullet)

- [ ] **Step 1: Rewrite** the README GitLab section: setup now happens in Settings → Plugins → GitLab; `irix.json` and `IRIX_*` stay documented as the underlying mechanism; one paragraph on the restart note for merge-request features. Update the IRIX.md row to list the setup screen. Integrate into existing text, do not append.
- [ ] **Step 2: Format** `npm run format:files -- irix/README.md IRIX.md`.
- [ ] **Step 3: Final verification**: `npx vitest run plugins/irix-gitlab --bail=1 > /tmp/irix-gitlab-tests.txt 2>&1`, read the file; `npm run typecheck:server`; `npm run lint -- plugins/irix-gitlab`.
- [ ] **Step 4: Commit** `docs(irix-gitlab): document the setup screen`.
