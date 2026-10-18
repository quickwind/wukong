# Irix: read this first

This repository is **Irix**, a company-internal fork of [Paseo](https://github.com/getpaseo/paseo).
It lives on the `irix` branch of `quickwind/irix` (a fork of `getpaseo/paseo`; remotes are
`origin` = the fork, `upstream` = Paseo). Whoever you are, human or AI agent, and whichever tool you
use, this file comes first. Where it disagrees with upstream's `CLAUDE.md`/`AGENTS.md`, this file
wins; where it is silent, upstream's rules apply.

## What Irix is for

Paseo on company Windows machines, where nothing may be sent to cloud services:

- Agent providers: **Claude Code and Devin CLI only** (Devin runs as the ACP provider `devin acp`).
- The only forge is the **company GitLab**, driven through python-gitlab. No `glab`, no GitHub.
- **No traffic from the daemon to the internet.** Loopback only, plus an explicit allowlist.
- Delivered as **seven npm tarballs** (`@irix/*`), installed with `npm install -g`. No desktop or
  mobile app. The team uses Windows and has no administrator rights.
- Runs next to a normal Paseo install: own command (`irix`), home (`~/.irix`), port (6890).

## The prime rule: the smallest possible footprint on upstream

We want to merge upstream often and cheaply. Every line changed in an upstream file is a future
merge conflict. An earlier attempt (the `internal-edition` branch, kept only for reference) edited
126 upstream files and was abandoned for exactly that reason. This branch edits **40 upstream
files, 399 lines** (`upstream-footprint.mjs`, 2026-10-18), which is the whole budget (40 files, 400
lines): the next upstream edit has to pay for itself by removing another; everything else is new
files.

Before editing an upstream file, go down this ladder and stop at the first rung that works:

1. **Add a new file** under an Irix-owned path (below) and wire it in from existing extension
   points: the `ForgeRegistry`, the plugin system, provider config, `runner` injection.
2. **Configure instead of code:** environment, defaults, or the daemon's own settings.
3. **Gate by edition:** `isIrixActive()` on the server, `IRIX_BUILD` in the app. Upstream
   behaviour must stay byte-for-byte the same when the gate is off.
4. **Swap, don't edit:** `upstreamOnly(Component)` replaces one component with nothing by
   changing a tag name; `HIDDEN_ROW_STYLE` hides a row with a one-line style. Neither moves
   upstream's markup.
5. **Last resort: edit upstream, as little as possible.** One to a few lines, a `// Irix: why`
   comment on them, no renames, no moving code, no reformatting. If the formatter re-indents a
   wrapped block, undo the change and use rung 4 (a 3-line change once became 20 lines that way).

Also: build-time changes beat source changes. The brand (name, icons, logo, strings) is applied to
a throwaway checkout when packaging, never committed into upstream's files. The npm scope
(`@getpaseo` to `@irix`) is rewritten the same way.

### Checking the rule

```sh
git fetch upstream
node irix/scripts/upstream-footprint.mjs     # lists every upstream file we modify
```

It fails if an upstream file is deleted or renamed, if a modified upstream file has no `Irix`
marker in the lines added, or if the totals pass the budget (40 files, 400 lines; change with
`--max-files`/`--max-lines`). **Run it before every commit that touches upstream files** and when
you add one, add it to the table below. `rg "Irix:"` finds every marker.

## Where Irix lives

| Path                           | What                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `IRIX.md`                      | This guide                                                                                                                  |
| `irix/`                        | Brand assets, scripts (pack, publish, brand, sync helpers), README, install guide                                           |
| `irix/README.md`               | Configuration, GitLab setup, building, publishing                                                                           |
| `irix/INSTALL-WINDOWS.md`      | What the team does on Windows: install, update, first run, usage, plugins                                                   |
| `packages/server/src/irix/`    | Daemon policy: egress guard, providers, plugins, GitLab adapter, clone policy                                               |
| `packages/cli/src/irix/`       | `irix` command defaults (home, port, ignore Paseo's environment); `irix` has no clone, onboard, pair, hub or speech command |
| `packages/app/src/irix/`       | Web UI switches (`IRIX_BUILD`, `upstreamOnly`, hiding helpers)                                                              |
| `plugins/irix-gitlab/`         | Bundled plugin: GitLab setup screen, Add project from GitLab, Fork clone, Open folder dialog, Open in Devin                 |
| `plugins/irix-devin-usage/`    | Bundled plugin: Devin ACU usage, forecast                                                                                   |
| `.github/workflows/irix-*.yml` | Publish to npm; weekly sync with upstream                                                                                   |

## Upstream files we touch (the whole list)

`upstream-footprint.mjs` is the source of truth; this is the why. Paths are under `packages/`
(`server/src/...`, `app/src/...`) unless they start with `CLAUDE.md`.

| File                                                                                                                       | Why                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `CLAUDE.md` (`AGENTS.md` links to it)                                                                                      | One line at the top pointing agents here                                                                     |
| `server/daemon-worker.ts`                                                                                                  | Imports the edition entry first (egress guard, policy)                                                       |
| `server/agent/providers/acp-agent.ts`, `terminal/terminal.ts`                                                              | One line each: Windows shell comes from `irixWindowsShell()` (PowerShell by default)                         |
| `server/config.ts`                                                                                                         | Terminal profiles fixed to Claude Code                                                                       |
| `server/session.ts`                                                                                                        | Clone requests only from the company GitLab                                                                  |
| `server/agent/provider-registry.ts`                                                                                        | Restrict to Claude and Devin; Devin as configured ACP, with Irix's Devin client                              |
| `server/plugins/index.ts`                                                                                                  | No managed sources; only Irix's bundled plugins                                                              |
| `server/plugins/compiler.ts`                                                                                               | Lets plugins written for `@getpaseo/plugin` build here                                                       |
| `server/services/forge-registry.ts`                                                                                        | GitLab is the only forge                                                                                     |
| `server/scripts/supervisor.ts`                                                                                             | `windowsHide` so Windows shows no daemon console window                                                      |
| `server/session/daemon/daemon-self-updater.ts`                                                                             | Refuses "Update daemon": it would install upstream's packages from npm                                       |
| `app/screens/settings/host-page.tsx`                                                                                       | Hides Update daemon, the agent tools, browser tools and skills cards, and Remove host (Restart daemon stays) |
| `app/add-project-flow/options.ts`, `components/add-project-flow.tsx`                                                       | "Clone from GitLab" in place of GitHub                                                                       |
| `app/components/sidebar/sidebar-help-menu.tsx`, `community-links.tsx`, `changelog/.../changelog-source.ts`                 | No upstream links, no What's new request                                                                     |
| `app/components/add-host-method-modal.tsx`                                                                                 | No pairing-link option (it reaches the public relay)                                                         |
| `app/composer/input-mode.ts`                                                                                               | No dictation or voice mode                                                                                   |
| `app/screens/settings-screen.tsx`, `settings/host-page.tsx`, `settings/providers-section.tsx`, `settings/plugins-page.tsx` | No pairing, locked providers and terminal profiles, local-folder plugin text                                 |
| `app/usage/queries.ts`                                                                                                     | Pinned usage re-reads on a timer (Irix builds only)                                                          |
| `app/plugins/react-native/ui.ts`, `plugin/src/client/ui.ts`                                                                | Plugins get `ui.AgentView` and `ui.capabilities` (one re-export each; code and types are Irix files)         |

## Design decisions, and why

- **Egress guard** (`packages/server/src/irix/egress-guard.ts`; everything named `irix/...` in
  this section is under `packages/server/src/`): one hook on `net.Socket#connect` in the daemon
  process refuses non-loopback hosts unless allowlisted (`IRIX_ALLOWED_HOSTS`, the GitLab host,
  the Devin hosts). It also refuses to listen anywhere but loopback. It covers whatever upstream
  adds later. It **does not cover** child processes (provider CLIs, `git`, `python-gitlab`,
  `npm`) or **third-party plugins**, which run in their own forked process (verified: one reached
  the internet). The bundled plugins run inside the daemon and are covered.
- **Devin client** (`irix/devin-client.ts`, chosen from `provider-registry.ts` the way upstream picks
  its Cursor and Kimi clients): ACP has no system prompt and upstream's ACP session never reads
  `config.systemPrompt`, so Bots' identity and soul never reached Devin. The client puts the
  instructions in the new session's first `session/prompt` as a block of their own, by wrapping the
  connection call rather than `startTurn` (which would echo them into the chat). Devin's replay joins
  that block to the user's first message when a session resumes, so the client also cuts it back out
  of `streamHistory`. Verified with the real Devin: it answers with the instruction, the chat shows
  only what was typed before and after a daemon restart, and later messages need no re-injection.
  It also turns on `waitForInitialCommands`: Devin sends the "/" command list in a notification after
  the session opens, and upstream's ACP client answers from its cache unless that switch is on, so
  the 10 s wait (`DEVIN_COMMANDS_WAIT_MS`, upstream's is 1.5 s) was never used before. A gap was not
  reproduced on macOS (52 commands in 130-160 ms, also with 30 sessions starting at once, old build
  and new alike); the switch is a hedge for a slower machine (Windows reports of a late popover are
  unconfirmed).
  For bots the Bots plugin goes one better: it keeps an always-on Devin rule (`.devin/rules/bot-identity.md`)
  in each bot's own folder and, for a Devin chat in that folder, does not pass `systemPrompt`, so the two
  never both deliver the same text. Devin fixes a session's rules when it is created, and caps each
  always-on rule file at 32 KiB.
  **Paseo's agent tools in Devin:** Paseo hands other providers its tools (message an agent, list
  agents, ...) as an MCP server. On a company machine Devin drops it: with a team MCP registry Devin
  connects only the registry's servers and silently ignores the ones a client passes in `session/new`
  (seen in its log: "Fetched 123 servers from 1 MCP registries", the registry's servers connected, ours
  never tried; `devin-mcp-probe.mjs` and `devin-mcp-log.ps1` in `irix/scripts` show it). So the same
  first-prompt block also tells Devin to use the `irix` command from its shell (`agent ls`, `send`,
  `logs`, `wait`, `run`; the CLI reads `PASEO_AGENT_ID` so a message says who sent it). Verified with the
  real Devin: it ran `irix agent ls` and answered; each shell command asks for the usual approval. Only
  a new session gets the block, so a Devin chat made before this stays without it. Devin also ignores
  a server whose name it has seen before; a rename fix was tried and dropped as it helps only where
  MCP is allowed (it is in git history, commit `f7cec3d70`). Irix homes default
  `daemon.mcp.injectIntoAgents` to true, which serves Claude Code.
  On Windows a quoted message run by Devin (`irix send <id> "What are you doing?"`) reached the CLI cut at
  the spaces with the quote marks still on, so the receiver got `"What`. `bin/irix` now passes the
  arguments through `mendSplitQuotedArgs` (`packages/cli/src/irix/argv.ts`), which joins an opening
  quote and its later closing quote back into one message. The cause on the Windows side (which shell
  Devin runs commands in) is not known; only the symptom is handled.
  **Devin's shell output in the chat:** Devin runs commands through ACP `terminal/create`, reads them with
  `terminal/output`, releases the terminal, and only then completes the tool call with the text
  `Exited with code 0`. It never puts the terminal in the call's content, so the chat showed no output
  while Devin had it (seen with `devin acp` on macOS and Windows). `acp-agent.ts` keeps released terminals
  (up to 32) and gives a call without terminal content the output of the terminal that ran the same command.
  Two gaps the guide covers: an agent started or messaged from the CLI does not notify its caller when
  it finishes (only the MCP tools arm that; verified, the child's `ParentAgentId` is set but no message
  comes back), so Devin is told to wait or to ask the agent to `irix send` its answer back; and the
  skills Paseo installs for agents name MCP tools, so Devin is told to map them to `irix` commands.
  `brand.mjs` rewrites `paseo <command>` to `irix <command>` in those skills at pack time, since
  Irix ships no `paseo` command. Paseo's `browser_*` tools have no CLI, so Devin has none.
- **Providers:** removed from the registry, not merely disabled. Terminal profiles are fixed to
  Claude Code. The Providers page and Add provider catalog are hidden. Claude starts disabled when
  its command is not found at daemon start (`detectIrixProviders` in `irix/providers.ts`); an
  explicit enabled setting wins, and installing Claude later takes effect at the next start.
- **Plugins:** local folders only. npm, Git and registry sources are switched off because they run
  child processes the guard cannot see. A friendly error says so. Plugins written for Paseo still
  work: `irix/plugin-sdk-alias.ts` maps `@getpaseo/plugin` to the local SDK name. The upstream
  scope there is written as `["@get", "paseo/plugin"].join("")` so the publish-time rename does not
  rewrite it; do not "simplify" it into one string (lint also rejects `"@get" + "paseo"`).
- **GitLab:** upstream's `createGitLabService` takes a `runner`. `gitlab/glab-runner.ts` answers
  the `glab` command lines that service issues with python-gitlab calls, so upstream's ~1400 lines
  of GitLab logic run unchanged and no `glab` executable exists to clash with a user's own.
  Contract tests drive upstream's service through it, so an upstream change to a command line fails
  a test instead of failing silently. Rebase merge is not supported. Configuration is
  `<home>/irix.json` or `IRIX_GITLAB_*`; the URL must be https. The GitLab settings screen (Command Center item, or the button on the GitLab
  page; built-in plugins have no Settings → Plugins row) writes both the python-gitlab
  config and `irix.json` (`plugins/irix-gitlab/server/setup/`, `client/setup-controller.ts`); the adapter reads `irix.json` once, so a changed section needs a restart.
- **Add project:** upstream's dialog is kept (search a directory, New directory). Its GitHub entry
  becomes Clone from GitLab, which opens the plugin screen with search, Clone and Fork clone
  (fork, wait, clone your fork, add `upstream`; shown for any project outside your namespace) and
  a progress dialog. **Open folder** shows an in-app folder dialog (`app/irix/folder-picker-dialog.tsx`, mounted in
  `add-project-flow.tsx`) that browses the disk through the daemon (`irix.fs.list-folders`,
  `irix.fs.create-folder`), because a browser cannot learn a real path. The OS folder dialog it
  replaced (`pick-folder.ts`) started slowly, was the old tree-style one on Windows, and needs
  PowerShell, which company policy may restrict; it is kept but no longer reached. The dialog
  is drawn inside Add project's own modal on purpose: Add project is a react-native-web `Modal` that
  traps focus, and a dialog in the app's overlay root (`AdaptiveModalSheet`, a second `Modal`) makes
  the two pull focus back and forth forever and freezes the page. Plugin RPCs time out after 30 s, so long jobs are start + poll.
- **Devin usage** (`plugins/irix-devin-usage`): Devin has no public per-member quota API. The
  plugin makes the call the CLI's `/usage` makes (`GetUserStatus`, from the host in the CLI's own
  `credentials.toml`) and sends the key only to an allowlisted https host. The allowlist exists in
  two places that must agree: the plugin and `irix/devin-hosts.ts` (a test checks). Reset is the
  first of the calendar month (UTC); `planEnd` is the contract end, not a cycle. A limit of 0
  shows as fully used. Forecast weather is projected month-end use against the limit.
- **Packaging:** `node irix/scripts/pack-local.mjs --out <dir>` builds seven tarballs from the
  last commit in a throwaway folder (scope `@irix`, brand applied, web UI built with
  `EXPO_PUBLIC_IRIX=1`). Version is `<upstream core>-irix.<timestamp>`; the app package keeps
  upstream's version because Expo rejects other forms. All seven must be installed together or npm
  fetches upstream packages and the guard's promise is gone.
- **Isolation from Paseo:** only an `irix` binary (no `paseo`), home `~/.irix` or
  `IRIX_HOME`, port 6890, and the CLI ignores `PASEO_HOME`/`PASEO_HOST` inherited from a
  terminal opened inside Paseo.
- **Web UI:** served by the daemon, on by default. English only: Irix's added strings are not in
  the translation tables, to keep i18n files untouched.

- **`ui.AgentView` for plugins** (`app/src/irix/agent-view.tsx`, `agent-view-shell.tsx`; types in
  `plugin/src/client/irix-ui.ts`; how to use it: `irix/README.md`): Paseo's own conversation
  embedded in a plugin screen, so the Bots chat gets timeline renderers, composer pills and the model,
  mode and thinking pickers without a copy of the chat UI. Props are
  `agentId`, `serverId`, `workspaceId` (all required, the plugin passes them; Irix does not look the
  workspace up) and an optional `onOpenWorkspaceFile`. Irix builds only: elsewhere both exports are
  `undefined`. Plugins detect it with `typeof ui.AgentView === "function"` and
  `ui.capabilities?.agentView === 1`, as Bot Crew does in `client/native-agent-view.ts`, and fall
  back to their own chat window otherwise; `agentView` is the props version, bumped on an
  incompatible change. Three things to keep: the shell is `require`d on first render, because a
  static import closes a loop through the plugin registry (`registry` -> `evaluate` -> `ui` -> chat
  screen -> `registry`); it renders upstream's `AgentConversationPanel` inside its own
  `PaneProvider`, so nothing in upstream is edited for it (the upstream footprint is one re-export
  line in each of `plugins/react-native/ui.ts` and `plugin/src/client/ui.ts`); and it registers the
  agent with `viewedTimelineSync` under a source id of its own, because without a registered viewer
  the conversation waits on history forever, and a shared id would let one view release another's.
  Not provided, because there is no workspace behind it: opening subagent tracks, the import sheet,
  and file links unless the plugin passes `onOpenWorkspaceFile`. Checked with the real Devin and
  Bot Crew 0.2.0-offline.25: history and streaming, scrolling, model and mode pickers, permission
  cards, plugin timeline renderers and composer pills, switching `agentId`, two views at once.
  Unit tests: `app/src/irix/agent-view*.test.ts(x)`.

## License and attribution

Paseo is Apache-2.0, Copyright (c) 2025-present Mohamed Boudra (`LICENSE` at the repo root, no
`NOTICE` upstream). Modifying, renaming and using it inside the company is allowed. This is a
technical reading, not legal advice; have the company's legal team confirm before any external
distribution.

What we do about the conditions of §4 and §6:

- **Copy of the license (§4a):** `irix/scripts/add-license.mjs` runs at pack time (in
  `pack-local.mjs` and the publish workflow) and puts upstream's `LICENSE` and a `NOTICE` in each of
  the seven packages and sets `license: Apache-2.0`. It refuses if `LICENSE` stops being Apache 2.0.
  The workflow's smoke test checks the installed packages. Without it the tarballs ship no license.
- **Notice of changes (§4b):** every modified upstream file carries an `Irix` comment
  (`upstream-footprint.mjs` enforces it) and git history shows the rest. The `NOTICE` summarises
  the changes.
- **Keep notices (§4c):** do not remove or rewrite upstream copyright, license or attribution
  text. The brand step only touches UI strings, icons and metadata in a throwaway checkout.
- **Attribution in the product:** a brand rule adds a License row to the About page ("Irix is a
  modified version of Paseo ... Apache License 2.0"). The rule fails the build if its anchor
  moves, and a test checks it appears once.
- **Trademarks (§6):** the product name, logo and icons are Irix's own; do not reintroduce
  Paseo's logo or name as the product's. Internal identifiers (`PASEO_*`, `~/.paseo`) are
  technical and stay for cheap merges.
- **Third-party code** (npm dependencies, bundled web UI libraries) keeps its own licenses. We add
  none and remove none. `python-gitlab` (LGPL) is installed separately and run as its own program,
  never bundled or linked.

Obligations apply on redistribution. Internal use is not that; handing tarballs to contractors or
another company, or publishing to a public npm registry, is. Before either: legal review, the
LICENSE and NOTICE in the tarballs (check them), and a look at the open points below.

### Rules for every change

Check these before you commit anything that adds code, a dependency, a file or an asset. They are
what keeps the sections above true.

1. **Never remove or edit upstream's legal text.** `LICENSE`, copyright lines, SPDX or license
   headers and attribution wording stay as upstream has them. In a merge conflict over them, take
   upstream's. If upstream adds a `NOTICE`, `add-license.mjs` already carries it into ours; if it
   changes the license itself, stop and ask (the script refuses to pack).
2. **A new dependency (npm or Python, or a vendored library, font, icon or image) needs its
   license looked at first.** Run `node irix/scripts/license-audit.mjs` (everything we ship;
   `--since <ref>` for just what a change added). `blocked` means GPL, AGPL, SSPL, BUSL,
   non-commercial or unlicensed: do not add it. `review` (LGPL, MPL, EPL, CC-BY, unknown, vendor
   terms) needs a person's decision, written down under "Known gaps". Permissive (MIT, ISC, BSD,
   Apache-2.0) is fine. Add dependencies the normal way; do not copy a library's source into the
   repo. If you must vendor, keep its LICENSE beside it and add it to the NOTICE.
3. **Code from somewhere else** (a GitHub project, a blog, a forum answer, another tool's output)
   is not ours to paste. Reading a project to learn a protocol and writing your own code is fine;
   that is how the Devin usage plugin was written. Copying code is fine only if its license is
   permissive and compatible: keep its copyright and license header and say where it came from
   in the file. If you do not know the license, do not copy it.
4. **Assets must be ours or licensed for this use.** The logo, icons, fonts and images in
   `irix/brand/files` must not be Paseo's, nor another party's artwork, characters or
   trademarks. Say where a new asset came from (who made it, or its license) in the commit
   message. Never use Paseo's name or logo as the product's identity; mentioning it to credit it
   is fine and is what the About page does.
5. **Do not bundle or redistribute software with its own terms.** Claude Code, the Claude Agent
   SDK, Devin CLI, `git` and `python-gitlab` are installed by the user or by npm from its own
   source. Never put their binaries in our tarballs. A third-party plugin you hand to others
   keeps its own LICENSE with it.
6. **Do not weaken the notices.** Do not drop `LICENSE` or `NOTICE` from the packages, the
   `Apache-2.0` field, the About page row, or the smoke-test checks for them. A test failing on
   them is the point.
7. **New outward-facing behaviour** (publishing, sharing tarballs outside the company, a public
   registry) is a decision for the maintainer and legal, not a code change: see below.

Open points for the company to decide: who owns copyright in Irix's own additions and whether to
add a company notice (AI-assisted work, such as the logo artwork, has unsettled copyright status);
whether a public name "Irix" needs a trademark check; and whether the Devin usage plugin's call
to an unofficial Devin endpoint is acceptable under the company's agreement with Cognition.

## Lessons that cost time (do not relearn them)

- `npm run typecheck:server` does **not** compile `packages/server/scripts/`. Also run
  `npx tsc -p packages/server/tsconfig.scripts.json --noEmit`, or packaging fails late.
- A "background task completed" notice means the shell command ended, not that it succeeded. Check
  the exit code and the output file, then install the tarballs into a temp prefix before reporting.
- A mocked test can hide a real bug: the guard blocked a bundled plugin and tests that only used
  loopback never saw it. For network or UI behaviour, run the real daemon (and a real browser for
  UI) in a temp home on another port.
- `fetch failed` hides the cause in `error.cause`; surface the code (certificate, refused, DNS).
- proto3 JSON omits zero values, so a missing number is zero.
- Windows: a detached process has no console, so child console programs open a window unless
  `windowsHide` is set; Git for Windows checks out CRLF (hash checks must ignore line endings);
  `npm` is a `.cmd` (needs a shell); path length limits (260) argue for short build folders;
  PowerShell redirection writes UTF-16.
- Windows and symlinks: upstream tracks 7 symlinks, including `AGENTS.md` (to `CLAUDE.md`) and
  `packages/server/AGENTS.md`. Git for Windows without symlink rights (the default, and no admin
  here) checks them out as small text files holding the target path, so `AGENTS.md` is a one-line
  file reading `CLAUDE.md`. That is harmless: the content is in `CLAUDE.md`, which carries the
  pointer to this file, and Claude Code and Devin CLI both read `CLAUDE.md`. An agent that reads
  only `AGENTS.md` should open `CLAUDE.md`, then this file. `git status` stays clean. Do not turn
  `AGENTS.md` into a regular file (that changes an upstream file), and do not set
  `core.symlinks=true` without the privilege (checkout then fails).
- Windows builds: `npm` is `npm.cmd`, which only a shell can start. Upstream's
  `scripts/build-daemon-web-ui.mjs` spawns it without one and fails on Windows ("spawn npm
  ENOENT"), so `irix/scripts/build-fixes.mjs` patches it in the throwaway pack checkout. Add a
  rule there (not an upstream edit) for the next upstream script that breaks on Windows. GitHub's
  Windows runner runs steps in Git Bash, whose GNU tar reads `C:\...` as host:file: give `tar` bare
  names and a `cwd`. **Look at CI after every push**; the Windows job once failed for days unseen.
- **Never kill processes by name** (`pkill`, `pgrep | kill`): the user's main Paseo daemon on 6767 is
  titled "Paseo Daemon" too, and so was the Irix trial instance on 6890. Stop what you started with
  `irix daemon stop` on your own `IRIX_HOME`, or by the PID the start printed. When testing against
  the real Devin, give the test daemon its own `IRIX_HOME` (the real `HOME` stays so Devin finds its
  login), and read only: Devin's `credentials.toml` is not yours to open.
- Shell: macOS `sed -i` needs `''`; zsh does not word-split `$VAR`; `npx oxlint` fails outside the
  repo root (config), so use the npm scripts.

## Before you commit or pack

Follow upstream's rules (`CLAUDE.md`: lint and typecheck after every change, **run only the test
files you changed**, never the whole suite, use the npm scripts for lint and format). Also:

1. `npm run lint`, `npm run format:check`, `npm run typecheck:server` (and the `tsc -p` above).
2. The Irix tests you touched: `npx vitest run <file>` in `packages/server`, `packages/app` or
   `plugins`; `node --test "irix/scripts/*.test.mjs"`.
3. `node irix/scripts/upstream-footprint.mjs` if you touched an upstream file.
4. For anything user-visible, run it for real: temp home, own port, never `6767` (the main Paseo
   daemon; do not restart it) and not `6890` if someone is using it.
5. Packaging: `node irix/scripts/pack-local.mjs --out ~/irix-dist` (one batch only; it clears
   earlier tarballs there), then install them into a temp `--prefix` and run `irix --version`.
6. If you added a dependency, a copied snippet, a file from elsewhere or an asset: apply "Rules for
   every change" under License and attribution, and run
   `node irix/scripts/license-audit.mjs` (exit 1 means something shipped is `blocked`).
7. Commit with a message that says why (and where an asset or snippet came from); push to
   `origin irix`.

## Syncing with upstream: the SOP

**Cadence.** Weekly, and before every release. Do not let it drift past a month: the cost grows
with the gap. Reference points: the first sync (92 upstream commits) had 4 text conflicts and
took most of a day to check; a later one (13 commits, 100 files) merged clean and only one file
we touch had changed upstream.

**Who does what.** `irix-sync-upstream.yml` (Mondays, or run it by hand) mirrors `main` to
upstream, merges upstream into `sync/upstream-<date>`, builds, runs the Irix checks and opens a
PR, or opens an issue naming the conflicting files. A green PR is **not** a reviewed merge. The
workflow cannot judge the things in step 4; a person or agent must.

**Rules that never bend**

- Merge with a **merge commit**. Never rebase `irix` onto upstream and never squash-merge a
  sync: either one erases the merge base and the next sync re-fights every old conflict.
- Merge in a throwaway branch or worktree, never straight into `irix`. Nothing lands until
  step 5 passes. `irix` stays unchanged until then, which is also the rollback.
- Never touch the Paseo daemon on port 6767, and keep test daemons on their own home and port.
- Take upstream's side, then re-apply our hook. Never "keep ours" for a whole upstream file.

**Steps**

1. **Look first.** `git fetch upstream --tags`, `git config rerere.enabled true`. See the size
   (`git log --oneline irix..upstream/main`) and try the merge without making it:
   `git merge-tree --write-tree --name-only irix upstream/main`. Clean prints a tree id and
   exits 0; conflicts list the files.
2. **Merge in a worktree.**
   `git worktree add -b sync/upstream-<date> ../irix-sync irix && cd ../irix-sync && git merge upstream/main`.
3. **Resolve conflicts.** Take upstream's version of the file, then re-apply our hook: one to a few
   lines with an `Irix:` marker (the table above says what each hook is for). If upstream moved
   or rewrote what a hook sat on (the forge registry, plugin loader, Add Project flow, usage), find
   the new place and go back down the ladder. Resolutions are remembered by rerere.
4. **Review what a clean merge can still get wrong.**
   - Hooks intact: `node irix/scripts/upstream-footprint.mjs` passes, and the file count and
     `rg "Irix:"` still match the table above. A lost marker means a lost hook.
   - Files we hook that upstream also changed:
     `comm -12 <(git diff --name-only <old-base> upstream/main | sort) <(git diff --name-only <old-base> irix | sort)`.
     Read those diffs; they are where auto-merge is most likely to be wrong.
   - **New outbound traffic.** The guard stops the daemon, not the browser or child processes. In
     what upstream added: `git diff -U0 <old-base> upstream/main -- packages ':!packages/website' ':!*.test.*' ':!*.md' ':!packages/app/src/i18n' | rg '^\+' | rg -o 'https?://[^"` ]+|fetch\(|new WebSocket\('`.
     Look for new hosts, update checks, telemetry, relay, Hub, push, speech downloads, registries.
     Then load the built web UI in a browser against a temp daemon and confirm no request leaves
     localhost.
   - **New providers, built-in plugins, usage sources, forges.** Providers and bundled plugins are
     allowlists (`IRIX_PROVIDER_IDS`, `IRIX_BUILTIN_PLUGINS`), so new ones stay off; confirm
     they did, and that nothing new bypasses the allowlist or the `ForgeRegistry`.
   - **Contracts we lean on.** `glab-runner.test.ts` fails if upstream changes a `glab` command
     line it issues. Also read upstream's changes to the plugin SDK (`UsageSourceRegistration`,
     RPC timeouts), `usage/window-bar.tsx` (`runsOutAt`) and `usage/queries.ts`, the Add Project
     flow, `supervisor.ts` and the provider registry.
   - **License and notices.** `git diff <old-base> upstream/main -- LICENSE NOTICE` must be empty
     (anything else: read it, and stop if the license changed); then
     `node irix/scripts/license-audit.mjs --since <old-base>` lists the dependencies upstream
     added to what we ship (exit 1 = a `blocked` one, do not take it as is; `review` = a person
     decides). Check that nothing new bundles software with its own terms (rule 5 above).
   - Version bump? Check `pack-local` and the app config still accept the new version form.
5. **Verify**, in the worktree: `node scripts/npm-retry.mjs ci --ignore-scripts`, `npm run postinstall`,
   `npm run build:server` (it also compiles `packages/server/scripts`), `npm run typecheck`,
   `npm run lint`, `npm run format:check`, `node --test "irix/scripts/*.test.mjs"`, the Irix
   tests (`packages/server`: `src/irix`; `plugins`: `irix-gitlab irix-devin-usage`;
   `packages/app`: `src/irix src/usage`), and the footprint script. Do not run the whole suite.
6. **Package and smoke test.** `node irix/scripts/pack-local.mjs --out <dir>`, install the
   tarballs into a temp `--prefix`, then start that daemon on a temp home and port. Check:
   `irix --version`; only `claude` and `devin` providers; `irix-gitlab` and
   `irix-devin-usage` loaded; no `Irix blocked` line in `daemon.log` at startup; the page
   title is Irix. Anything you changed by hand in step 3 gets a real run, not just tests.
7. **Land it.** Push the sync branch and merge it into `irix` with a merge commit (PR, or a
   local `--no-ff` merge). Then fast-forward nothing else: `main` is the workflow's to mirror.
8. **Finish.** Tag the result (`irix-<date>`, annotated, naming the upstream version), repack
   into `~/irix-dist` with the same `pack-local` command, update the upstream-files table here
   if the footprint changed, and tell the team to update with `windows-update.ps1`.

**If it goes wrong.** More conflicts than expected, or upstream rewrote a subsystem we hook: stop,
leave `irix` alone, and settle it in the worktree; never force-push. A build failure that is
upstream's own: fix it with the smallest marked change and consider sending it upstream. A step
you could not run goes into "Known gaps" below; do not report the sync as verified without it.

**What the workflow covers.** Steps 1, 2, most of 5 (brand tests, build, typecheck, lint, the
Irix tests, the footprint check) and opening the PR or issue. It does not do 3, 4, 6, 7 or 8.

## Known gaps (as of this writing)

Not verified, so do not claim otherwise:

- No run against the real company GitLab (19.0). Auto-merge is the likeliest to break
  (python-gitlab only takes the older parameter). The 17-item acceptance checklist is in
  `docs/internal-edition.md` on the old `internal-edition` branch.
- Devin usage was checked against the real service only through a probe and the team's use;
  `GetUserStatus` is unofficial and may change.
- The GitHub workflows (publish, sync, the Windows job) have never run on GitHub; nothing has been
  published to npm. `irix/scripts/disable-upstream-workflows.sh` has not been run.
- The package `@anthropic-ai/claude-agent-sdk` (and its platform binaries) is a runtime dependency
  of `@irix/server` under Anthropic's own terms ("SEE LICENSE IN ..."), not an open-source
  license. npm installs it for the user; we do not redistribute it. The company's agreement with
  Anthropic should cover using it. `license-audit.mjs` lists it as `review`; no other shipped
  package is `review` or `blocked` (325 shipped packages checked from the lockfile's license
  fields, which are what each package declares about itself).
- No third-party license notices ship with the web UI bundle (the libraries compiled into it,
  mostly MIT or Apache-2.0, ask for theirs to be kept). Upstream ships the same bundle; for any
  distribution beyond the company we need a generated third-party notices file.
- Third-party plugins are not covered by the guard (see above); only install ones you trust.
- `ui.AgentView`: in a narrow pane (for example Bot Crew with its settings panel open) upstream's
  responsive composer hides the mode picker. In a new chat that has no model chosen yet, "/" lists
  nothing for any provider, Devin included: upstream's `listDraftCommands` returns `[]` without a
  model. A plugin slash command was not seen in the "/" popover with a Devin chat in this test
  setup; not investigated.
- Claude usage is off (upstream's `claude-usage-source` is not enabled).
- Settings has "Enable terminal agent hooks", which edits the user's agent config files. It is
  upstream's and installs hooks only when switched on (unset means off). Keep it off while Paseo
  is installed beside Irix, or both write hooks into the same Claude config.

## Working agreements with the maintainer

- Say what was verified and what was not. Never present "tests pass" as "works" for behaviour you
  did not run. Report failures with the output.
- Confirm before anything outward-facing or hard to reverse: publishing to npm, changing GitHub
  repository settings, force-pushing, deleting someone's data. Pushing commits to `origin irix`
  is routine.
- Reading a person's login token (Devin's `credentials.toml`, a Claude keychain entry) needs their
  say-so, and the token must never be printed or logged.
- Reply in the language the maintainer writes in (Chinese so far). The team's product UI is
  English.
- Keep the footprint small even for nice-to-haves. If a feature needs a bigger upstream change,
  say so and offer the alternative before building.
