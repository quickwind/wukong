# Irix: read this first

This repository is **Irix**, a company-internal fork of [Paseo](https://github.com/getpaseo/paseo).
It lives on the `irix` branch of `quickwind/irix` (a fork of `getpaseo/paseo`; remotes are
`origin` = the fork, `upstream` = Paseo). Whoever you are, human or AI agent, and whichever tool you
use, this file comes first. Where it disagrees with upstream's `CLAUDE.md`/`AGENTS.md`, this file
wins; where it is silent, upstream's rules apply.

## What Irix is for

Paseo on company Windows machines, where nothing may be sent to cloud services:

- Agent providers: **Claude Code and Devin CLI only** (Devin runs as the ACP provider `devin acp`).
- The only forge is the **company GitLab**, reached over its REST API (gitbeaker), with the token from the team's python-gitlab config. No `glab`, no GitHub.
- **No traffic from the daemon to the internet.** Loopback only, plus an explicit allowlist.
- Delivered as **seven npm tarballs** (`@irix/*`), installed with `npm install -g`. No desktop or
  mobile app. The team uses Windows and has no administrator rights.
- Runs next to a normal Paseo install: own command (`irix`), home (`~/.irix`), port (6890).

For a numbered list of what Irix changes on top of upstream, split into enhancements and changes
made because of company restrictions, see
[irix/docs/changes-from-upstream.md](irix/docs/changes-from-upstream.md). **Every change to Irix
must update both this file (`IRIX.md`) and `irix/docs/changes-from-upstream.md` in the same
commit.**

## The prime rule: the smallest possible footprint on upstream

We want to merge upstream often and cheaply. Every line changed in an upstream file is a future
merge conflict. An earlier attempt (the `internal-edition` branch, kept only for reference) edited
126 upstream files and was abandoned for exactly that reason. This branch edits **60 upstream files, 559 lines** (`upstream-footprint.mjs`, against v0.13.0). The
budget is 60 files and 560 lines. It was 40 and 400. Every raise is recorded here, with its
reason: the Name + Create bar (the New workspace screen and the new chat tab are upstream code, so no
Irix-owned file can replace them) took it to 45 files and 420 lines, hiding a plugin-managed
project from the sidebar (same reason) took the lines to 440, and Devin's skills in the ACP command
list (one line in `acp-agent.ts`) took them to 447, which moved the budget to 450. The plugin `Markdown` component was carried by hand for a while (upstream 995ad2f87, #7579); v0.13.0 ships it and the copy is gone. Later work (schedules and agent messaging switched off, subagent approval, bypass modes, the CLI and daemon hooks) took it to 462. Fork checkouts then needed `upstream` in the source picker (branches, background fetch, pasted links), which took it to 484, and the setup block for a merge request from another project (below) to 488. Comments on lines of a file (below) took it to 56 files and 506, and the budget to 56 and 510. Content search in the Files panel (below) took it to 57 files and 515, and the budget to 57 and 515. Irix workspace scripts in `paseo.json` (below) took it to 58 files and 543 lines, and the budget to 58 and 550. Approval for agent-started agents and schedules (below) took it to 60 files and 559 lines, and the budget to 60 and 560. The two lists of
changes were merged, so the numbers above are measured on the merge, not the sum of the two
branches. Prefer new files; an upstream edit that raises the budget again gets its line here.

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
marker in the lines added, or if the totals pass the budget (60 files, 560 lines; change with
`--max-files`/`--max-lines`). **Run it before every commit that touches upstream files** and when
you add one, add it to the table below. `rg "Irix:"` finds every marker.

## Where Irix lives

| Path                           | What                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `IRIX.md`                      | This guide                                                                                                                         |
| `irix/`                        | Brand assets, scripts (pack, publish, brand, sync helpers), README, install guide                                                  |
| `irix/AGENTS.md`               | Windows build recipe and the traps that cost time when packaging                                                                   |
| `irix/docs/`                   | Changes from upstream (numbered list); agent fork: mechanism guide, and staff training notes                                       |
| `irix/README.md`               | Configuration, GitLab setup, building, publishing                                                                                  |
| `irix/INSTALL-WINDOWS.md`      | What the team does on Windows: install, update, first run, usage, plugins                                                          |
| `packages/server/src/irix/`    | Daemon policy: egress guard, providers, plugins, GitLab adapter, clone policy                                                      |
| `packages/cli/src/irix/`       | `irix` command defaults (home, port, ignore Paseo's environment); `irix` has no clone, onboard, pair, hub or speech command        |
| `packages/app/src/irix/`       | Web UI switches (`IRIX_BUILD`, `upstreamOnly`, hiding helpers)                                                                     |
| `plugins/irix-gitlab/`         | Bundled plugin: GitLab setup screen, Add project from GitLab, Fork clone, Open folder dialog, Open in Devin, Open in File Explorer |
| `plugins/irix-devin-usage/`    | Bundled plugin: Devin ACU usage, forecast                                                                                          |
| `plugins/irix-claude-usage/`   | Bundled plugin: Claude monthly spend cap (and session/weekly windows where a plan has them)                                        |
| `plugins/irix-context-hint/`   | Bundled plugin: composer pill when an agent's context window passes a threshold; compact or start a new session                    |
| `plugins/irix-content-search/` | Bundled plugin: content search in the Files panel (`rg --json` behind start, poll and cancel RPCs)                                 |
| `.github/workflows/irix-*.yml` | CI checks on every push to `irix` (the publish job is switched off); weekly sync with upstream                                     |

## Upstream files we touch (the whole list)

`upstream-footprint.mjs` is the source of truth; this is the why. Paths are under `packages/`
(`server/src/...`, `app/src/...`) unless they start with `CLAUDE.md`.

| File                                                                                                                                                                                                                                                     | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md` (`AGENTS.md` links to it)                                                                                                                                                                                                                    | One line at the top pointing agents here                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `server/daemon-worker.ts`                                                                                                                                                                                                                                | Imports the edition entry first (egress guard, policy)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `server/agent/providers/acp-agent.ts`, `terminal/terminal.ts`                                                                                                                                                                                            | One line each: Windows shell comes from `irixWindowsShell()` (PowerShell by default); `acp-agent.ts` also spreads `additionalDirectoriesParams(...)` into `session/new`, `session/load` and `session/resume`, reads a provider's skills from `irix/command-kind.ts`, leaves out the auto-accept feature (`irixFeatures`), and keeps released terminals for Devin's shell output                                                                                                 |
| `server/config.ts`                                                                                                                                                                                                                                       | Terminal profiles fixed to Claude Code                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `server/websocket-server.ts`                                                                                                                                                                                                                             | Builds the connected-hosts registry through `createIrixConnectedHosts` (always empty in Irix)                                                                                                                                                                                                                                                                                                                                                                                   |
| `server/session.ts`                                                                                                                                                                                                                                      | Clone requests only from the company GitLab; pull request text without the LLM (`irix/pr-text.ts`, two lines); `beforeSessionRun` hook                                                                                                                                                                                                                                                                                                                                          |
| `server/agent/provider-registry.ts`                                                                                                                                                                                                                      | Restrict to Claude and Devin; Devin as configured ACP, with Irix's Devin client; `onRegistryClientAttached` hook                                                                                                                                                                                                                                                                                                                                                                |
| `server/plugins/index.ts`                                                                                                                                                                                                                                | No managed sources; only Irix's bundled plugins (`irixBuiltinPlugins`)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `server/plugins/compiler-build.ts` (was `compiler.ts` until upstream 0.14.0 moved the build into a worker)                                                                                                                                               | Lets plugins written for `@getpaseo/plugin` build here                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `server/services/forge-registry.ts`                                                                                                                                                                                                                      | GitLab is the only forge                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `server/package.json` (and the lockfile)                                                                                                                                                                                                                 | One dependency, `@gitbeaker/rest`, for the GitLab REST client; JSON has no comments, so no marker                                                                                                                                                                                                                                                                                                                                                                               |
| `server/scripts/supervisor.ts`                                                                                                                                                                                                                           | `windowsHide` so Windows shows no daemon console window                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `server/session/daemon/daemon-self-updater.ts`                                                                                                                                                                                                           | Refuses "Update daemon": it would install upstream's packages from npm                                                                                                                                                                                                                                                                                                                                                                                                          |
| `app/screens/settings/host-page.tsx`                                                                                                                                                                                                                     | Hides Update daemon, the agent tools, browser tools and skills cards, and Remove host (Restart daemon stays)                                                                                                                                                                                                                                                                                                                                                                    |
| `app/add-project-flow/options.ts`, `components/add-project-flow.tsx`                                                                                                                                                                                     | "Clone from GitLab" in place of GitHub                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `app/components/sidebar/sidebar-help-menu.tsx`, `community-links.tsx`, `changelog/.../changelog-source.ts`                                                                                                                                               | No upstream links, no What's new request                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `app/components/add-host-method-modal.tsx`                                                                                                                                                                                                               | No pairing-link option (it reaches the public relay)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `app/composer/input-mode.ts`                                                                                                                                                                                                                             | No dictation or voice mode                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `app/screens/settings-screen.tsx`, `settings/host-page.tsx`, `settings/providers-section.tsx`, `settings/plugins-page.tsx`                                                                                                                               | No pairing, locked providers and terminal profiles, local-folder plugin text, bypass-modes switch hidden                                                                                                                                                                                                                                                                                                                                                                        |
| `app/usage/queries.ts`                                                                                                                                                                                                                                   | Pinned usage re-reads on a timer (Irix builds only)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `app/plugins/react-native/ui.ts`, `plugin/src/client/ui.ts`                                                                                                                                                                                              | Plugins get `ui.AgentView` and `ui.capabilities` (one re-export each; code and types are Irix files)                                                                                                                                                                                                                                                                                                                                                                            |
| `app/hooks/use-sidebar-workspaces-list.ts`, `app/screens/new-workspace-screen.tsx`                                                                                                                                                                       | A plugin-managed project (Bot Crew's `Bots`) is left out of the sidebar and the New workspace project list and preselection; one call each into `app/src/irix/managed-projects.ts`; also the Name + Create bar (`app/irix/workspace-name.tsx`): create the workspace first, chat after                                                                                                                                                                                          |
| `app/composer/draft/workspace-tab.tsx`                                                                                                                                                                                                                   | Same bar for a new chat tab (`IrixCreateAgentBar`): name it and create it with no first message                                                                                                                                                                                                                                                                                                                                                                                 |
| `server/workspace-git-fetch.ts`, `server/session/checkout/checkout-session.ts`, `protocol/src/messages.ts`, `app/screens/new-workspace-picker-item.ts`, `app/git/forge-refs.ts`, `app/composer/forge-auto-attach.ts`, `server/paseo-worktree-service.ts` | Fork checkouts: the background fetch also fetches `upstream` (`irix/upstream-remote.ts`), its branches are listed with a `remote` field and shown as their own rows (`app/irix/remote-branch.ts`), and a pasted merge request or issue link of another project on the host is accepted and checked by project (`app/irix/forge-reference.ts`). One to three lines each; `paseo-worktree-service.ts` only asks `irix/workspace-automation.ts` whether there is anything to block |
| `app/panels/agent-panel.tsx`                                                                                                                                                                                                                             | A new chat tab is titled with the name given in `IrixCreateAgentBar`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `app/file-panels/builtin.tsx`, `app/file-panels/source/editor/view.web.tsx`, `app/file-panels/source/readonly/view.web.tsx`, `app/review/feedback/use-feedback.ts`                                                                                       | Comments on lines of a file: the built-in file panels render inside `withIrixFileComments` (the file and workspace the comments belong to, and the send button), the two CodeMirror source views add the extension from `app/irix/file-comments/use-extension.web.ts`, and the diff's send takes the workspace's file comments along. One to three lines each; everything else is under `app/src/irix/file-comments/`                                                           |
| `app/components/file-explorer-pane.tsx`                                                                                                                                                                                                                  | Content search: the Search in files button in the toolbar, and the search panel in place of the tree while it is open (`app/irix/content-search-host.tsx`, through `Irix.useSearch` and `Irix.TreeMenu`). Five new lines and two renamed tags (+7 -2)                                                                                                                                                                                                                           |

## Design decisions, and why

- **Egress guard** (`packages/server/src/irix/egress-guard.ts`; everything named `irix/...` in
  this section is under `packages/server/src/`): one hook on `net.Socket#connect` in the daemon
  process refuses non-loopback hosts unless allowlisted (`IRIX_ALLOWED_HOSTS`, the GitLab host,
  the Devin hosts). It also refuses to listen anywhere but loopback. It covers whatever upstream
  adds later. It **does not cover** child processes (provider CLIs, `git`,
  `npm`) or **third-party plugins**, which run in their own forked process (verified: one reached
  the internet). The bundled plugins run inside the daemon and are covered.
  **The GitLab host is allowed by the code that is about to use it**, not at startup: the REST client
  (`gitlab/rest-client.ts`) allows the host of `gitlab.url`, and the bundled `irix-gitlab` plugin allows
  the host of whatever URL it is about to call (the setup form's URL included). The plugin runs in this
  process and cannot import the guard, so `installEgressGuard` leaves a function under
  `Symbol.for("irix.allowEgressHost")` on `globalThis`; it accepts a bare host name only. Python-gitlab
  ran as a child process and was never blocked, so this was missing when the REST client replaced it,
  and every GitLab call failed with "Irix blocked a connection". `IRIX_ALLOWED_HOSTS` still works.
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
  **Devin's slash commands** (`irix/command-kind.ts`, one line in `acp-agent.ts`): upstream shows the
  commands a provider reports at the start of a message, and only its skills inside one, because a skill
  also works there. ACP has no skill/command distinction, so upstream marked every command a plain one and
  the mid-prompt list was empty for Devin. Devin does say which are skills: it files them under the
  "Skills" category in the command's `_meta` (`cognition.ai/category`), so that is what the hook reads.
  Verified with the real Devin: 54 commands, 32 of them skills. Only the skills are offered mid-prompt,
  because the others do not work there — Devin's ACP server runs a command only when it opens the message
  ("hello /context" reaches the model as text), while a skill's instructions are injected wherever
  "/<skill>" appears. The ACP session cannot tell which provider it belongs to (every ACP client
  registers under the "acp" sentinel), so the marker in the command is the only signal there; no other
  provider writes Cognition's namespace, so the other ACP providers are unaffected.
  **Additional directories** (`irix/additional-directories.ts`, spread into `session/new`, `session/load`
  and `session/resume` in `acp-agent.ts`): a plugin that runs a chat in one directory and wants the agent
  to work in another (a bot's folder next to a project worktree) sets
  `config.providerOptions.additionalDirectories`, an array of absolute paths, the field Claude already takes.
  It is sent only when the agent lists `additionalDirectories` under `sessionCapabilities` in `initialize`
  (Devin does); entries that are not absolute paths are dropped with a warning, and the chat starts anyway.
  Verified with the real Devin: the extra directory's `.devin/rules` load, and writing there asks no
  approval. Without it Devin loads rules from the working directory and its git root only, and asks once
  per session before a write elsewhere. `session/load` does not remember the directories: a resumed
  session asks again unless they are sent again, which is why `session/load` and `session/resume` carry
  them too (the stored `providerOptions` come back with the agent's saved config).
  **Host capabilities** (`irix/host-caps.ts`): plugin servers are forked from the daemon and inherit its
  environment, so `edition.ts` sets `IRIX_HOST_CAPS` to JSON (`devinSystemPrompt`,
  `devinAdditionalDirectories`). A plugin reads `JSON.parse(process.env.IRIX_HOST_CAPS ?? "{}")`, and anything
  but `true` means no: stock Paseo never sets it.
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
  `daemon.mcp.injectIntoAgents` to true; in `cli` mode (below) neither provider is given the tools anyway.
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
  Irix ships no `paseo` command, and in the command line's own hints and errors ("Use `paseo ls` to list
  agents"; about 30 files), because an agent that follows a hint to a command that does not exist wastes a turn.
  A source checkout still prints `paseo` there; only the packed build is rewritten. Paseo's `browser_*` tools have no CLI, so Devin has none.
- **Agent guide and agent tools** (`irix/agent-guide.ts`, `agent-tools-setting.ts`, `claude-agent-guide.ts`;
  the CLI half is `removeSwitchedOffCommands` in `packages/cli/src/irix/surface.ts`): Claude and Devin are in the same
  position on a company machine, where MCP may be barred and neither tells the daemon when it drops a
  server, so the daemon cannot detect it. Agents are taught the `irix` command line instead, by a guide
  built from the host's switches when a session starts: `send` and the "report back" advice only when agent
  messaging is allowed (otherwise: start a new agent with the whole task, `wait`, read `logs`), the
  `schedule` family only when schedules are allowed, the approval policy when subagent approval is on.
  Devin gets it in its first prompt and in its stored config (`devin-client.ts`, new sessions only; the stored copy is how a resume learns which mode the agent was made in). Claude gets it appended to
  `daemonAppendSystemPrompt` by a patch on `ClaudeAgentClient.prototype`, installed when the provider
  registry is built; no chat message. The guide is fixed when the agent is created: with the real Claude CLI, a
  resumed session ignores a new appended system prompt and keeps its first one (created with "the secret word is
  ALPHA", resumed with "BRAVO", it still answers ALPHA). So Paseo's MCP tools are fixed at creation as well, or an old
  agent would be told one thing and given another. A resume reads the guide the agent was created with from its stored
  metadata and passes it through unchanged; the agent gets Paseo's MCP server, and the per-agent tool policy the MCP
  route checks (`getPaseoToolPolicy`), only if that guide is not the command-line one (no guide counts as MCP, as
  agents made before this were). The server entry is built fresh from the agent manager's address and token, which
  change at every daemon start (`mcpBaseUrl`, `mcpAuthToken`, `paseoToolPolicies` are private members, pinned by a test).
  Devin takes the same path (`agent-tools-resume.ts` serves both; `DevinACPAgentClient.resumeSession` calls it), and
  nothing in Irix or upstream keeps MCP away from Devin: the only way Paseo's server reaches it is
  `config.mcpServers` in `session/new`, `session/load` and `session/resume`, which follows this setting. Checked with
  the real Devin 3000.11 on macOS: made in Irix-tools mode and resumed under MCP it stays without the server; made
  over MCP and resumed under Irix tools it keeps it with a fresh token and lists `list_agents`. A Devin with a team
  MCP registry may still drop the server (see above), which is Devin's choice. An agent's own MCP servers (Claude's
  settings, Devin's own config) are never touched; a local server in `.mcp.json` still worked in Irix-tools mode.
  Checked with the real Claude (Haiku 5.5): made in Irix-tools mode and resumed under MCP it still has no `paseo`
  tools; made over MCP and resumed under Irix tools it calls `list_agents` (without the policy step it connected but
  was left with no tools).
  One setting, `daemon.agentTools` in `<home>/daemon.json` (`cli` by default, or `mcp`), covers both
  providers. It is fixed to `cli` and the Settings → host → Agents row is hidden unless
  `IRIX_UNRESTRICTED` or `IRIX_ALLOW_AGENT_TOOLS` is set in the daemon's environment
  (`server_info.features.agentToolsEditable` tells the app). In `cli` mode the daemon config store's `get()`
  reports `paseoTools.enabled: false` for `claude` and `devin`, so the agent manager hands them neither the
  MCP server nor the in-process tools (it reads that policy at every start); nothing upstream is edited, but
  the app's cached config shows those two flags too (the Providers page is hidden in Irix).
  The `irix` command leaves out what the daemon would refuse: `schedule` and `heartbeat` unless
  `IRIX_UNRESTRICTED` or `IRIX_ALLOW_SCHEDULES` is set, and `send` (also `agent send`) unless
  `IRIX_UNRESTRICTED` or `IRIX_ALLOW_AGENT_MESSAGING` is set **and** `PASEO_AGENT_ID` is set, because only an
  agent's message is refused, so a person at a terminal keeps `send`. It reads the same variables the daemon
  does: an agent's shell inherits the daemon's environment (`baseEnv: process.env` in the Claude session), the
  way `isCliSubagentApprovalRequired` already works. A person who lifts a switch on the daemon only has
  to set it in their own shell to see the command. The daemon enforces its switches whatever the command
  line shows, and no file in the home says what is switched on (an earlier version wrote one; it was
  dropped so the switches stay unadvertised). A switch change needs a daemon restart and reaches new agents only.

- **Approval for agents and schedules started by an agent** (`irix/create-approval.ts`, the CLI half in
  `cli/src/irix/surface.ts` and `caller-routing.ts`): the daemon decides, the CLI only routes. `irix run`
  and `irix agent run` send `callerAgentId` (read from `PASEO_AGENT_ID`, and only if the daemon knows that
  agent). The daemon then raises the synthetic approval card in the caller's chat before anything is
  created: `createSessionAgent` asks first thing, ahead of any worktree, and a workspace created with an
  agent asks before the workspace exists. That approval reaches the agent step as a symbol-keyed mark on
  the request's `agent` object, which the session spreads into the agent step and which JSON cannot carry,
  so one request raises one card and no later request can reuse the answer. A resent workspace request
  that the creation service answers from its record (agent made, completed, or outcome unknown) is not
  asked again. A caller that idle release has closed is loaded to show the card. When no card can be
  shown (unknown or archived caller) the error says so instead of "rejected by user".
  The CLI never reads stdin for an agent. `caller-routing.ts` hooks the client's session-request send,
  on the command's own connection: inside an agent's shell, while the daemon reports
  `requireSubagentApproval`, a creation that names no caller the daemon knows is refused, and the four
  `schedule/*` requests that can start an agent get the checked caller id (one lookup per connection) and
  no deadline, since the approval can take ten minutes (creation requests already use `timeout: 0`). A
  person at a terminal with no calling agent still gets the yes/no prompt; with no terminal the run is
  refused without reading stdin.
  Schedules: creating a new-agent schedule, resuming a paused one, running one once, and an update that
  changes prompt, cadence, agent config, run limit or expiry are asked; the card shows the stored prompt
  when the request carries none. `callerAgentId` is optional in those four protocol schemas, so old
  clients and daemons still parse each other. MCP `create_schedule`, `resume_schedule`,
  `run_schedule_once` and `update_schedule` use the same rules from the tools gate in
  `subagent-approval.ts`, looking the schedule up first, so a missing schedule or one that messages an
  existing agent gets the tool's own error and no card. A name-only update, resuming an active schedule,
  and the daemon's own ticks are not asked: an approved schedule keeps running. Denial, the ten-minute
  timeout, or the calling agent being closed or interrupted denies the request and takes the card down.
  An agent's shell tool gives up on a long command: Devin's fails the call after 30 s ("The command
  timed out after 30 seconds"), Claude's moves it to the background after 120 s. So an agent's `irix run`
  does not block until a person answers. `caller-routing.ts` gives the request an idempotency key
  (`pending-run.ts`: a file in `<home>/pending-runs/` keyed by the caller and the request's content, good
  for ten minutes, deleted once the request has an outcome), waits 20 s (`IRIX_APPROVAL_WINDOW_MS`), and
  exits with `SUBAGENT_APPROVAL_PENDING`, telling the agent to run exactly the same command again. The
  daemon keeps the request and the card open: creation requests carry a key, so the creation service keeps
  running them after the connection closes, and the repeat attaches to the running one. A repeat of a
  pending question joins it rather than raising a second card, a refusal is remembered under the same key
  for ten minutes so the repeat is refused without a new card, and a person who accepts after the CLI has
  gone still gets the agent created (an agent the parent never collects, if it never reruns; that is
  what the card said). The agent guide teaches the rerun. Requests without a key (the `schedule/*`
  requests) are still withdrawn when their connection closes (`cancelIrixApprovals`, called from
  `websocket-server.ts` when the last socket closes, not after the 90 s reconnect grace), so with Devin a
  schedule approval must come within its 30 s. Cards are in English: the daemon has no locale and Irix's
  UI is English only. A card carries its choices (provider, model, mode, thinking, directory, title, prompt; for
  a schedule the cadence, agent config, limits and the stored prompt) as a `plain_text` detail built by
  `approval-form.ts`, which the app draws as aligned lines in a monospace block; the JSON `input` stays
  for other readers (`irix permit ls`). A real form widget would need an app change. Devin's own `run_subagent` card uses the same text. Its hook now carries an explicit `timeout` of 11
  minutes (`HOOK_TIMEOUT_SECONDS`): with none, a subagent ran while its card was still waiting (answer
  "NOPE" before anyone clicked, Devin 3000.11, seen in `out/approval-e2e`); with it, the card held for over
  three minutes, Deny stopped the subagent and Accept let it run. Not yet verified: the full ten minutes,
  or that Devin counts the timeout in seconds as assumed (the three-minute hold fits seconds).
  Claude's own Task/Agent tool had the same kind of hole, for a different reason. Irix puts
  `permissions.ask: ["Task", "Agent"]` in the session settings, but where the organization's managed
  Claude settings set `allowManagedPermissionRulesOnly` and `allowManagedHooksOnly` (the
  `remote-settings.json` that Claude Code caches in `~/.claude`), Claude ignores that rule, and its Agent
  tool asks for nothing by default: with those settings a `deny` or `allow` rule given as a project file,
  `--settings` or `--allowedTools` has no effect either (checked with Claude Code 2.1.311). Only
  `--disallowedTools` still works. A hook passed in-process through the SDK is not a settings hook and still
  runs, so `addSubagentAskHook` (`subagent-approval.ts`) adds a `PreToolUse` hook for `Task|Agent` that
  answers "ask" while approval is required; Claude then calls the permission handler and the app shows its
  card (Always ask, Auto and Bypass all checked). It is attached to the real session by the prototype patch
  in `idle-release-sessions.ts`: the registry hands the manager a facade without the session's members, and
  the `wrapClaudeClient` patch in `subagent-approval.ts` only ever touched the facade, so the ten-minute
  timeout wrapper on `handlePermissionRequest` was not applied before either. Claude builds the card for that tool and shows
  the tool input as JSON; `addSubagentCardDetail` (same file) sets a `detail` on it before the event goes out
  (the request object is shared with the pending list), so it reads as a form: subagent type, model,
  description, background, prompt. The model line is what the agent chose (for example "sonnet", and a
  subagent started that way did run on `claude-sonnet-5-5`), or "not set" with the starting agent's model: in
  the runs checked an unset model meant the same model as the parent, but a built-in subagent type may
  define its own default, so the card does not claim more than that.
  Residual limits, on purpose: the identity is a routing signal, not a credential. A shell that drops
  `PASEO_AGENT_ID`, or a client that writes its own WebSocket messages, looks like a person; the daemon
  cannot tell it from the app's own New chat, so it cannot ask. A caller that allocates a
  pseudo-terminal gets the stdin prompt, which it controls. `irix run --new-workspace` makes a bare
  workspace (not gated) before the agent step asks, so a denial leaves that empty workspace behind.
  Schedule requests with no calling agent are not asked.
  Tests: `create-approval.e2e.test.ts` and `schedule-approval.e2e.test.ts` run a real daemon (allow, deny,
  caller closed or idle-released, setting off, no worktree before the answer, one card per request,
  resent request, a request that outlives its connection); `create-approval.test.ts` covers the timeout,
  the mark, the stored prompt, joining and remembered refusals; `caller-routing.test.ts` and
  `pending-run.test.ts` cover the CLI routing and the window.
- **Providers:** removed from the registry, not merely disabled. Terminal profiles are fixed to
  Claude Code. The Providers page and Add provider catalog are hidden. Claude starts disabled when
  its command is not found at daemon start (`detectIrixProviders` in `irix/providers.ts`); an
  explicit enabled setting wins, and installing Claude later takes effect at the next start.
- **Upstream's idle collector is off** (upstream 0.14.0, #7782): it releases idle runtimes after a fixed
  hour and has its own settings card. Irix keeps its own release (below; 15 minutes, tuned for Devin's
  memory on Windows), so `applyIrixDefaults` (`packages/cli/src/irix/defaults.ts`) writes
  `agents.idleRuntimeCleanup: false` into a new home's `config.json`, and into an existing one that has no
  value; a value the user set is kept. Upstream's card in Settings → host still shows and is off. Upstream's
  `startAgentRun` now waits for a close in flight, but the known gap below remains: Irix closes through the
  public `closeAgent`, with no only-if-idle check; since 0.14.0 the racing prompt also is not in the saved
  timeline. If upstream's collector should replace Irix's, drop `idle-release*` and this default.
- **Idle release** (`irix/idle-release*.ts`, setting UI in `app/src/irix/idle-release-setting.tsx`):
  upstream keeps an idle agent's provider process for as long as the daemon runs
  (`docs/agent-lifecycle.md`, "Runtime residency"). On Windows each idle `devin acp` grew past 170 MB,
  and 31 of them used up a 32 GB machine and crashed the daemon. A sweep every minute calls upstream
  `AgentManager.closeAgent` on a Claude or Devin agent that has been idle for the configured time. The
  agent stays, closed, with its timeline; the next open or prompt resumes it through `ensureAgentLoaded`.
  Nothing happens when the Irix policy is off. It does not release an agent that has a turn running or a
  pending permission, an internal agent, one a client is viewing (visible and focused on it, with a
  heartbeat inside the idle window), a Devin with a terminal still running, or a Claude with a running
  background shell or provider subagent. The setting is `idleRelease: { enabled, minutes }` in
  `<home>/daemon.json`, beside `requireSubagentApproval`: on and 15 by default, minutes an integer from 1 to
  1440, edited under Settings → host → Agents, read on every sweep so a change needs no restart.
  Nothing upstream is edited. It hangs off the hooks Irix already had (`attachIrixAgentManager`,
  `attachIrixWsServer`). Upstream hands the manager a facade (`wrapSessionProvider` in
  `provider-registry.ts`) that hides the real provider session, so Irix patches the `createSession` and
  `resumeSession` prototype methods of `ClaudeAgentClient` and `ACPAgentClient` and keeps the real session
  by the launch context's agent id (`irix/idle-release-sessions.ts`). The probes read `terminalEntries`
  (`acp-agent.ts`) and `translateMessageToEvents` (`claude/agent.ts`) on that session, and the viewers come
  from `sessions` and `getClientActivity` (the ws server and `Session`). A test pins each upstream member
  and argument position. An agent whose real session cannot be resolved or inspected counts as busy and
  is never released.
  An agent is closed only when the same provider session was also releasable on the previous sweep, so
  every release waits one extra tick. A resumed agent keeps its old `updatedAt` and is releasable as soon
  as it loads; the extra tick keeps a prompt that resumes a released agent (an `irix send` to a child, a
  schedule) from seeing it closed again before the turn starts.
  **Known gap:** `closeAgent` does not check again, inside the agent's lifecycle lane, that the agent is
  still idle, and `startAgentRun` does not wait for a close in flight. What remains is an agent that is
  loaded and was already releasable on the previous tick, for example one that crossed the idle window or
  stopped being viewed or busy a minute earlier. A prompt from the CLI, a schedule or MCP that lands
  between load and run on its closing tick is recorded and never answered. A prompt from a focused client
  is safe: the viewers are read again right before each agent's close, and a focused agent counts as
  viewed. Irix cannot close the gap without patching private `AgentManager` methods. The fix belongs
  upstream: an only-if-idle `closeAgent`, or `startAgentRun` waiting on `inFlightAgentCloses`. The
  "residual hazard" test in `idle-release.test.ts` asserts the current outcome; when upstream fixes it,
  that test fails and becomes one that expects a reply.
- **No connected hosts** (upstream 0.13.0, #7370; `irix/connected-hosts-policy.ts`): the daemon never dials
  or accepts another daemon. `websocket-server.ts` builds its registry through
  `createIrixConnectedHosts`, which returns an always-empty one that refuses `add`, `update`,
  `remove` and `openRoute` (`HOSTS_DISABLED`) and never reads `hosts.json`. `irixServerFeatures`
  advertises `connectedHosts` and `hostMultiplexing` as false, so the app, CLI client and SDK report
  the feature as unsupported. `irix host` is removed (`cli/src/irix/surface.ts`) and the `list_hosts`
  agent tool is blocked. Neither `IRIX_UNRESTRICTED` nor an `IRIX_ALLOW_*` variable lifts this; only\n `IRIX_ENABLE_CONNECTED_HOSTS=1` in the daemon's (and CLI's) environment does. The egress guard\n still applies, so list each target in `IRIX_ALLOWED_HOSTS` (comma separated host names). SSH\n targets start a child `ssh` process, which the guard does not cover.
- **Plugins:** local folders only. npm, Git and registry sources are switched off because they run
  child processes the guard cannot see. A friendly error says so. Plugins written for Paseo still
  work: `irix/plugin-sdk-alias.ts` maps `@getpaseo/plugin` to the local SDK name. The upstream
  scope there is written as `["@get", "paseo/plugin"].join("")` so the publish-time rename does not
  rewrite it; do not "simplify" it into one string (lint also rejects `"@get" + "paseo"`).
- **GitLab:** upstream's `createGitLabService` takes a `runner`. `gitlab/glab-runner.ts` answers
  the `glab` command lines that service issues with method calls on a `GitLabClient`
  (`gitlab/client.ts`), so upstream's ~1400 lines of GitLab logic run unchanged and no `glab`
  executable exists to clash with a user's own. The client is `gitlab/rest-client.ts`: gitbeaker
  (`@gitbeaker/rest`, MIT) over GitLab's REST API inside the daemon, with every response parsed by
  the zod schemas in `schemas.ts`. No process starts per call (the python-gitlab CLI it replaced
  cost a Python start for each one). New GitLab features for agents go there: a method on
  `GitLabClient` and a call into gitbeaker, which already covers the rest of the API. Contract
  tests drive upstream's service through the runner, so an upstream change to a command line fails a
  test instead of failing silently. Rebase merge is not supported.
  **Credentials** (`gitlab/credentials.ts`) are still the team's python-gitlab config, read the way
  python-gitlab reads it: `GITLAB_PRIVATE_TOKEN`/`_OAUTH_`/`_JOB_` in the environment, else the
  `configSection` (or `[global] default`) of `~/.python-gitlab.cfg` (`PYTHON_GITLAB_CFG` replaces
  the file), with `helper:` commands run without a shell. Tokens are cached for 5 minutes, and
  dropped after a 401.
  **TLS trust** (`gitlab/system-ca.ts`): before the first GitLab call the daemon adds the operating
  system's CA store (Windows certificate store, macOS keychain, Linux bundle) to Node's default
  trust with `tls.setDefaultCACertificates`, so a company CA that is installed on the machine is
  trusted on every platform. This is process-wide, which is fine behind the egress guard.
  `NODE_EXTRA_CA_CERTS` still works, and `ssl_verify = /path/ca.pem` in the python-gitlab section
  adds that file. `ssl_verify = false` is ignored on purpose. It needs Node 22.15 or newer; on
  older Node only the bundled CAs and `NODE_EXTRA_CA_CERTS` apply.
  **Pull request text without a model** (`irix/pr-text.ts`, two lines in `session.ts`): upstream's
  button asks an agent to write the title and description, which starts a provider session on every
  click (many seconds on a Devin-only machine). With the Irix policy on, the metadata generator
  answers at once with an empty title and description. GitLab's new merge request page fills those in
  itself, and the API path (no `upstream` remote) drafts them just before it creates the request, the
  way GitLab does: one commit gives its subject and body; several give the tidied branch name as the
  title and the subjects, oldest first, as the description. Commit messages are still written by the
  model. The seam is the factory call in `session.ts`, which takes upstream's creator as an argument
  so the import block stays as it was.
  **Create merge request** (`gitlab/upstream-merge-request.ts`, wrapped around the service's
  `createPullRequest` in `adapter.ts`): upstream's button pushes the branch and then asks the forge
  service to create the request. When the checkout has an `upstream` remote on the configured GitLab
  that is a different project from `origin` (the layout Fork clone makes), nothing is created over the
  API. The daemon opens GitLab's "new merge request" page in the default browser of the machine it
  runs on (`rundll32 url.dll,FileProtocolHandler` / `open` / `xdg-open`, no shell), from the current
  branch of `origin` to the default branch of `upstream`, and gives only those two ends (the page is the fork's own, `<origin project>/-/merge_requests/new`, with `target_project_id` naming the upstream project; under the upstream project's path GitLab looks for the branch in the wrong project and reports it missing): GitLab fills
  the title and description itself from the commits and the project's template. The request exists
  once the person submits that page. Because upstream's client treats any answer as "created", the
  page-opened case is returned as an error, so the toast is red and reads "Opened the new merge
  request page in your browser (...)"; a client edit (two upstream files) would turn it into a plain
  notice. This works because Irix's daemon listens on loopback only, so the browser is on the same
  machine. Without an `upstream` remote, or when it is on another server or is the same project as
  `origin`, the request is created over the API as before.
  **A closed merge request does not hide the button.** Upstream treats a merge request that is closed
  but whose head commit is the branch's current commit as the branch's current one, so the button
  stayed "View merge request" until the branch got a new commit. `withoutAbandonedMergeRequest`
  (`gitlab/adapter.ts`, around `getCurrentPullRequestStatus`) reports none for a request that was
  closed without merging, so the button offers to create a new one; a merged request still shows,
  as merged.
  **Where a fork's merge requests are looked for** (`gitlab/fork-scope.ts`, `resolveMergeRequestScope`
  in `client.ts` / `rest-client.ts`): GitLab keeps a merge request in its target project, so for a
  checkout with an `upstream` remote on the same GitLab (a different project from `origin`) the
  requests are in the upstream project. Viewing, listing, merging, cancelling auto-merge and reading
  pipelines (`glab-runner.ts`) therefore ask the upstream project, and `mr list --source-branch` keeps
  only requests whose `source_project_id` is the fork's, because other people's forks may have a
  branch of the same name. Creating a request over the API and listing issues still use
  `resolveProject`, the project of `origin`. Approvals and discussions use the project the request
  names for itself. Without an `upstream` remote nothing changes. Not checked against a real GitLab:
  where a fork request's pipelines run and the permissions needed on the upstream project.
  **A fork in the New workspace source picker:** the picker lists branches (local and `origin`) and
  merge requests, and a pasted link can select one. Three things assumed `origin` was the only remote,
  and each now also knows `upstream`:
  the merge request's head is fetched from `upstream` first, then `origin` (`forkMergeRequestCheckoutRefs`
  in `gitlab/adapter.ts`, around `getPullRequestCheckoutTarget`; the merge request lives in the
  target project, so `origin` does not have `refs/merge-requests/N/head`); the daemon's background fetch (every
  180 s, only while a client watches the repository, only with an `origin`) also runs
  `git fetch upstream --prune` (`irix/upstream-remote.ts`, called from `workspace-git-fetch.ts`; a failed
  fetch is ignored so it never hides the `origin` result); and the branch response carries the fetched
  `upstream` branches in `branchDetails` with `remote: "upstream"` (optional protocol field), never in
  `branches`, which the branch switcher uses by name. The picker shows them as their own rows,
  `main (upstream)`, from `refs/remotes/upstream/<name>` (`app/src/irix/remote-branch.ts`), since
  `origin` may hold the same name at another commit. Pasting a merge request or issue link of another
  project on the host is accepted (`app/src/irix/forge-reference.ts`): Paseo only took links whose path
  was `origin`'s. The lookup is by number, so the item found must be in the project the link names, or
  a same-numbered request of another project would be attached. Not checked against a real GitLab.
  **A merge request from another project: the Setup tab.** Paseo marks a worktree made from a
  cross-project request untrusted and shows a Setup tab asking for approval before the project's scripts
  run (`untrustedSource`, set in `paseo-worktree-service.ts`). It did so even when the worktree has no
  `paseo.json` or one with nothing in it, so the tab asked about nothing. `hasWorkspaceAutomation`
  (`irix/workspace-automation.ts`) now has to say there is something that would run on its own (worktree
  setup or teardown commands, terminals, scripts) before the mark is set; a `paseo.json` that cannot be
  read counts as yes. The same mark gates teardown on archive and the workspace's scripts, so those are
  covered by the same check. The warning's repository name was `unknown repository`, because the GitLab
  service leaves the source project unnamed; `withSourceProjectName` (`gitlab/adapter.ts`) looks the
  project up from the request's `source_project_id` and puts its path (`me/app`) in `headOwnerLogin`,
  which the warning prints when there is no URL. A paseo.json added to the worktree after creation
  (the fork pushes a new commit and the user pulls it) is not covered by the mark. Not checked
  against a real GitLab.
  **The lookups behind the click are cached** (`gitlab/upstream-cache.ts`), because on a busy
  Windows daemon every git process waits in a queue (a `checkout_status_request` took 26 s in one
  log): the `origin` and `upstream` URLs are kept until the repository's config file changes (a `stat`
  of `<git common dir>/config`, no process; the first look costs one `git rev-parse` and two `git
config`), and the id and default branch of the two projects for a day, in memory (a restart asks
  again). A failed lookup is not kept. Adding an `upstream` remote changes the config file, so the next
  click sees it. The branch name needs no lookup: upstream computes it and passes it in. The same
  cached remotes serve `resolveProject` and the merge request lookups, which used to run `git config`
  once per command (about 100 of them in a 30 s window on one team machine).
  Configuration is `<home>/irix.json` or `IRIX_GITLAB_*`; the URL must be https. The `command` field
  no longer applies to the daemon; the plugin below still runs it. The GitLab settings screen
  (Command Center item, or the button on the GitLab page; built-in plugins have no Settings →
  Plugins row) writes both the python-gitlab config and `irix.json`
  (`plugins/irix-gitlab/server/setup/`, `client/setup-controller.ts`); the adapter reads `irix.json`
  once, so a changed section needs a restart.
  **The bundled plugin `irix-gitlab`** (project search, fork, setup test) uses the same gitbeaker in
  its own bundle: the plugin compiler bundles any npm package the plugin imports (only `zod` and the
  SDK are host modules), and the package resolves from the server's `node_modules` above the
  plugin's folder (checked in an installed-style layout). A plugin bundle cannot import daemon
  modules, so `plugins/irix-gitlab/server/credentials.ts` and `system-ca.ts` are copies of the
  daemon's, and `gitlab-plugin.test.ts` fails if they differ. The plugin has no `command` setting any
  more and the setup screen no longer asks for python-gitlab or uv.
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
  with nothing used (zeros, or left out as proto3 JSON does) is "No ACU quota on this Devin plan";
  a limit of 0 with ACU already used shows as fully used. Forecast weather is projected month-end
  use against the limit. Both usage plugins ship an `icon.svg` and register it (`icon: "icon.svg"`);
  without one the usage list and the sidebar footer show the same generic gauge for every source.
  Devin's is the app's own provider icon (`acp-provider-icons.ts`) and Claude's is upstream's
  Claude icon; a test in each plugin's test file keeps them equal to the provider's. A Devin agent's
  context window hover card shows the plan usage like Claude's does because `DevinACPAgentClient`
  passes `usageProvider: "devin"` (`devin-client.ts`): upstream's ACP session reports no usage
  account without it.
- **Context hint** (`plugins/irix-context-hint`): a composer pill that appears when an agent's context window
  passes the warning (50% by default) or critical (75%) threshold. Its menu offers `/compact`, a new agent in
  the same workspace with the same provider, model and mode (and switches to it, through a blank
  `open-agent` screen, since menu callbacks have no navigation), or "don't remind me" (hidden until the level gets
  worse or usage drops below the warning threshold). The client entry reads `lastUsage` from the agent list
  stream; the thresholds live in the plugin's settings (Command Center → "Context hint settings") and reach the entry
  through an RPC, because `useSettings` only works inside components. Nothing upstream is edited.
- **Claude usage** (`plugins/irix-claude-usage`): upstream's `claude-usage-source` stays off. It
  reads only the 5 hour and weekly windows, and an enterprise seat (`enterprise_usage_based`,
  checked 2026-10-24 on a Dell account) has neither: `/api/oauth/usage` returns them as `null`
  and puts the monthly spend cap in `spend`, so upstream's plugin would show one "Extra usage:
  Enabled" line. Ours reads the CLI's token from `~/.claude/.credentials.json` (or
  `CLAUDE_CONFIG_DIR`), never refreshes or rewrites it, and sends it only to `api.anthropic.com`.
  That host is open in the egress guard for this plugin (`irix/claude-hosts.ts`; the list exists
  in the plugin too and a test checks they agree), the one exception to "no daemon traffic to the
  internet" beyond Devin's and the GitLab host. It is an unofficial endpoint and may change. A
  session on Bedrock, Vertex or a custom `ANTHROPIC_BASE_URL` is not offered an account. Like
  Devin it shows month-end forecast weather, **assuming the spend cap resets on the first of the
  calendar month (UTC)**: the response carries no cycle, so that is unverified and the reset time
  and forecast are wrong if the contract bills on another day. Spend and cap both zero is "No
  usage quota on this Claude account"; a cap of zero with money already spent shows as fully used.
  The Mac keychain store is not read.
- **Packaging:** `node irix/scripts/pack-local.mjs` (output in `~/irix-dist` unless `--out <dir>`
  says otherwise; Windows build recipe and traps in [irix/AGENTS.md](irix/AGENTS.md)) builds seven tarballs from the
  last commit in a throwaway folder (scope `@irix`, brand applied, web UI built with
  `EXPO_PUBLIC_IRIX=1`). Version is `<upstream core>-irix.<timestamp>.g<short commit>`, with `.dirty` added when the working tree had uncommitted changes; the app package keeps
  upstream's version because Expo rejects other forms. All seven must be installed together or npm
  fetches upstream packages and the guard's promise is gone.
- **Installed-app icons** (`irix/brand/files/packages/app/public/pwa-icon-*.png`, rule in `brand.mjs`):
  an app installed from Chrome takes its window, taskbar and desktop icons from the manifest's icon
  list, choosing the entry that fits each size. Irix lists the mark alone at 16, 24 and 32 px and the
  mark with the name at 48, 192, 256 and 512 px, so the name shows only where it can be read. This is
  an experiment: the manifest has no per-surface setting, so which size each surface uses depends on
  Chrome and on the display scaling (at 150% the Windows taskbar asks for 48 px and gets the version
  with the name). `favicon.ico` and the browser-tab icons never carry the name. Redraw the small ones
  from `favicon-dark.svg` and the large ones from `icon.png` when the mark changes.
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

- **Plugin-managed projects stay out of the sidebar** (`app/src/irix/managed-projects.ts`): Bot Crew
  puts one workspace per bot under `<home>/plugin-data/bot-crew/shared/Bots/<botId>` and draws its
  own tree and Bots page, so the native `Bots` project would be a second, worse list, and its "+"
  would let people create workspaces in a folder the plugin owns. A project counts as managed when
  its root, or one of its hosts' roots, contains `/plugin-data/<plugin id>/` (Windows backslashes and
  letter case are folded; the ids are the list `MANAGED_PLUGIN_IDS`). The filter is display only,
  in two places: the sidebar's project list (`useSidebarWorkspacesList`) and `useNewWorkspaceInitialContext`
  in the New workspace screen, which also drops the preselected project when it came from the route
  (the global New workspace row passes the open workspace's project) or from the last workspace. The
  daemon, `paseo.workspaces.list`, `paseo.projects.list` and the other plugins still see the project:
  paseo-workboard reads both through the plugin host API on the server, so a task whose workspace is
  a bot's still lists, and a plugin's own workspace page still opens by `workspaceId`. Not hidden:
  the import-session sheet's project list, and anything that opens a workspace by id. `ui.capabilities.managedProjectsHidden` is exported from the same switch
  (`MANAGED_PROJECTS_HIDDEN`), so a plugin that draws its own tree of the project can tell whether the
  host also lists it.
- **Comments on lines of a file** (`packages/app/src/irix/file-comments/`): click a line number,
  drag or Shift+click for a range, or select text and press Comment, in the CodeMirror source views
  (web only; native is not built). The line numbers hook into the existing `lineNumbers` gutter
  through its facet, which merges handlers, so no upstream line configures it. A comment keeps its
  lines' text, because a send checks it against the open editor and says in the message when the
  lines moved, and because the agent reads the disk, not the unsaved editor. It goes to the agent as
  a `text` attachment starting `Paseo file comment attachment` (the diff's starts `Paseo review
attachment`), so neither the protocol nor the daemon changed. `dispatchComposerAgentMessage` takes
  composer attachments, and a `chat_history` one hands its text attachment to the wire untouched;
  that is the carrier. The diff's send takes the workspace's file comments along; with no diff
  comments the file view has its own send button. The rendered Markdown preview has no line
  markers, so a selection there is found again in the source's text
  (`markdown-source-map.ts`, letters and digits only, the text around the selection picks between
  repeated passages) and kept for those lines; when it cannot be placed it says so rather than
  guess. It is mounted by the same `withIrixFileComments` host, so it costs no upstream lines. The
  HTML preview is a sandboxed frame and only gets a pointer to the source view. Not built: sending them with the composer's text
  box, which needs a composer attachment kind and about five more upstream files.
- **Content search in the Files panel** (`plugins/irix-content-search`, app side in
  `packages/app/src/irix/content-search*.ts(x)`, `use-content-search.ts` and `open-search-match.ts`): the magnifier in the Files toolbar shows a search
  panel in place of the tree, with match case, whole word, regex (Rust syntax) and include/exclude
  globs, and results grouped by file. A click opens the file at the match line. Closing the search
  mounts the tree again, so its scroll position is lost: keeping it mounted would leave New file and
  New folder editing a hidden tree, and fixing that needs an upstream line. It is a bundled
  plugin that runs `rg --json` in the workspace folder through three plugin RPCs,
  `irix.search.content.start`, `.poll` and `.cancel`. Plugin RPCs time out after 30 s, so a search is
  started and then polled, and results show as each poll returns them. The protocol is unchanged and
  there is no `server_info` feature flag; when the daemon says the plugin or the RPC is unknown the
  panel says "Search is not available on this host. Update the host.", and any other error is shown
  as the daemon gave it. A search stops at 500 matches or 100 files, and a line is trimmed to 240
  characters around the match. A running search that gets no poll for 30 s is stopped, and at most
  four run at once on a daemon (a fifth stops the oldest). The start RPC only searches inside a
  folder the daemon lists as a workspace. `.git` is never searched, whatever the include globs say
  (`-g !.git` comes last; ripgrep lets the last matching glob win), and an exclude may be written
  with or without a leading `!`.
  **The bundled `rg`:** packing downloads ripgrep 15.2.0 (`irix/scripts/fetch-ripgrep.mjs`, run by
  `pack-local.mjs` after the brand step) into the throwaway checkout's
  `plugins/irix-content-search/vendor/<platform>-<arch>/`, for `win32-x64` and the packing machine's
  platform, and stops the pack if a file's SHA-256 is not the one pinned in `RIPGREP_ASSETS`. The
  binary is never committed. The plugin host tells a plugin no folder path, so the daemon looks for
  the binary under its builtin plugins folder at start (`packages/server/src/irix/ripgrep.ts`, called
  from `edition.ts`) and sets `IRIX_RG_PATH`; a value already set is kept. The plugin resolves the
  binary once, when it loads (`resolveRgBinary()` in `contribute`, `index.server.ts`): `IRIX_RG_PATH`,
  then the first `rg` in an absolute `PATH` entry (a relative one would resolve against the
  workspace). A source checkout uses the `rg` on `PATH` and without one gets "ripgrep (rg) was not
  found". The executable bit survives the copy into `dist/server/builtin-plugins`, `npm pack` and
  `npm install` (checked on macOS). What is not verified on Windows is under "Known gaps".
  **Replace** (milestone 2) is a fourth RPC, `irix.search.content.replace`, behind the pencil
  button in the search panel. The panel previews each match struck out with the replacement after
  it, lets a line or a whole file be left out, replaces one match or one file at once from a check button on its row, asks before Replace all, and sends the kept lines of each file with the
  modification time and size the search recorded for it. The daemon (`server/replace.ts`) skips a
  file, and reports why, when its time or size differ, when a line no longer matches, when the
  bytes at a match are not the ones found, or when it is not valid UTF-8. Otherwise it asks `rg
--json --replace` for the replacement text of every match on the kept lines, so `$1` means in
  replace what it means in search (in a search without the regex switch the text is literal), and
  changes only those bytes: line endings and a BOM stay as they were. The file is checked once
  more just before the write. Files are done one by one, a skipped one does not stop the rest, and
  the panel searches again afterwards. **Not built:** skipping a file with unsaved edits in the
  editor of this client. Doing it needs the file editor to register its buffer, which is an
  upstream edit. Today an open editor with unsaved text is not changed on disk by the check but
  is not detected either: its next save meets the file handle's conflict check and the editor
  shows its conflict callout, so no edit is lost silently. Changes that the editor has already
  autosaved (after 800 ms) are caught by the disk check.

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
- **Third-party code** (npm dependencies, bundled web UI libraries, the vendored binaries below)
  keeps its own licenses; we change and remove none of them. The python-gitlab config file format is
  read, but no python-gitlab code is used or installed.
- **Vendored binaries:** `@irix/server` ships ripgrep's release binaries (MIT or Unlicense; they
  link PCRE2, BSD-3-Clause with the PCRE2 exception) for content search. `add-license.mjs` appends
  their license texts, kept verbatim in `irix/licenses/`, to the server's `NOTICE`, and
  `fetch-ripgrep.mjs` puts ripgrep's own license files beside the binary. `irix/scripts/vendored.json`
  lists them for `license-audit.mjs`; a new vendored binary gets an entry there and a section in
  the NOTICE.

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
   SDK, Devin CLI, and `git` are installed by the user or by npm from its own
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
5. Packaging: `node irix/scripts/pack-local.mjs` (writes to `~/irix-dist`; one batch only; it clears
   earlier tarballs there), then install them into a temp `--prefix` and run `irix --version`.
6. If you added a dependency, a copied snippet, a file from elsewhere or an asset: apply "Rules for
   every change" under License and attribution, and run
   `node irix/scripts/license-audit.mjs` (exit 1 means something shipped is `blocked`).
7. **Keep both docs in sync:** every change that adds, alters or removes Irix behaviour or touches
   an upstream file must update this file (`IRIX.md`) and
   [irix/docs/changes-from-upstream.md](irix/docs/changes-from-upstream.md) in the same commit.
8. Commit with a message that says why (and where an asset or snippet came from); push to
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
   tests (`packages/server`: `src/irix`; `plugins`: `irix-gitlab irix-devin-usage irix-claude-usage irix-context-hint irix-content-search`;
   `packages/app`: `src/irix src/usage`), and the footprint script. Do not run the whole suite.
6. **Package and smoke test.** `node irix/scripts/pack-local.mjs`, install the
   tarballs into a temp `--prefix`, then start that daemon on a temp home and port. Check:
   `irix --version`; only `claude` and `devin` providers; the five bundled plugins (`irix-gitlab`,
   `irix-devin-usage`, `irix-claude-usage`, `irix-context-hint`, `irix-content-search`) loaded; no `Irix blocked` line in `daemon.log` at startup; the page
   title is Irix. Anything you changed by hand in step 3 gets a real run, not just tests.
7. **Land it.** Push the sync branch and merge it into `irix` with a merge commit (PR, or a
   local `--no-ff` merge). Then fast-forward nothing else: `main` is the workflow's to mirror.
8. **Finish.** Tag the result (`irix-<date>`, annotated, naming the upstream version), repack
   into `~/irix-dist` with the same `pack-local` command, update `IRIX.md` and
   `irix/docs/changes-from-upstream.md` if the footprint or behaviour changed, and tell the team to
   update with `windows-update.ps1`.

**If it goes wrong.** More conflicts than expected, or upstream rewrote a subsystem we hook: stop,
leave `irix` alone, and settle it in the worktree; never force-push. A build failure that is
upstream's own: fix it with the smallest marked change and consider sending it upstream. A step
you could not run goes into "Known gaps" below; do not report the sync as verified without it.

**What the workflow covers.** Steps 1, 2, most of 5 (brand tests, build, typecheck, lint, the
Irix tests, the footprint check) and opening the PR or issue. It does not do 3, 4, 6, 7 or 8.

## Known gaps (as of this writing)

Not verified, so do not claim otherwise:

- No run against the real company GitLab (19.0). Auto-merge is the likeliest to break
  (the client sends both `auto_merge` and `merge_when_pipeline_succeeds`). The 17-item acceptance checklist is in
  `docs/internal-edition.md` on the old `internal-edition` branch.
- Devin usage was checked against the real service only through a probe and the team's use;
  `GetUserStatus` is unofficial and may change.
- The GitHub workflows (publish, sync, the Windows job) have never run on GitHub; nothing has been
  published to npm. `irix/scripts/disable-upstream-workflows.sh` has not been run.
- The package `@anthropic-ai/claude-agent-sdk` (and its platform binaries) is a runtime dependency
  of `@irix/server` under Anthropic's own terms ("SEE LICENSE IN ..."), not an open-source
  license. npm installs it for the user; we do not redistribute it. The company's agreement with
  Anthropic should cover using it. `license-audit.mjs` lists it as `review`; no other shipped
  package is `review` or `blocked` (337 shipped packages checked: 335 from the lockfile's license
  fields, which are what each package declares about itself, and 2 from
  `irix/scripts/vendored.json`: ripgrep and the PCRE2 inside it).
- No third-party license notices ship with the web UI bundle (the libraries compiled into it,
  mostly MIT or Apache-2.0, ask for theirs to be kept). Upstream ships the same bundle; for any
  distribution beyond the company we need a generated third-party notices file.
- Third-party plugins are not covered by the guard (see above); only install ones you trust.
- `ui.AgentView`: in a narrow pane (for example Bot Crew with its settings panel open) upstream's
  responsive composer hides the mode picker. In a new chat that has no model chosen yet, "/" lists
  nothing for any provider, Devin included: upstream's `listDraftCommands` returns `[]` without a
  model. A plugin slash command was not seen in the "/" popover with a Devin chat in this test
  setup; not investigated.
- The GitLab REST client was tested against a local https server with a self-signed CA and not
  against the company GitLab. On the macOS test machine (Node 26.11, Darwin 27)
  `tls.getCACertificates("system")` returned no certificates although the keychain holds 158, so
  system-CA trust there was not seen working; Windows and Linux were not run either. Check with
  `node -e "console.log(require('tls').getCACertificates('system').length)"` on a team machine.
  `ssl_verify = false` in a team member's python-gitlab config no longer disables verification.
- Claude usage comes from `irix-claude-usage` (spend cap and a month-end forecast, see above); it
  was run against one real enterprise account, not a Pro or Max one, and its calendar-month reset
  is an assumption. Upstream's `claude-usage-source` is not enabled.
- Content search's Windows x64 `rg.exe` has not been run on a company machine, so allow-listing or
  antivirus, `windowsHide` and killing the child on Windows are unverified. Do not hand tarballs to
  the team before a person without administrator rights runs `rg.exe --version` and one search on
  a company machine.
- The Rust crates compiled into `rg` ship no license notices of their own (only ripgrep's and
  PCRE2's are in the NOTICE). This needs legal review before any distribution outside the company.
- Content search performance has one measurement: on a Mac, with this repository (about 6300
  files) in a browser, the first results arrived after about 290 ms and a result capped at 500
  matches in 98 files after about 450 ms; the longest browser main-thread stall was 2.5 ms. There is
  no Windows measurement and none on a larger repository.
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
