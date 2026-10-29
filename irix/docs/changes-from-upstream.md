# Irix changes from upstream Paseo

What Irix changes on top of upstream (measured against v0.13.0). Part A lists enhancements and
other changes. Part B lists the changes that exist only because of company restrictions. The
design, the reasons behind each change and the verification status are in [IRIX.md](../../IRIX.md).

Paths are under `packages/server/src/irix/` unless they say otherwise.

## A. Enhancements and other changes

### Devin integration

1. **Instructions in the first prompt.** ACP has no system prompt, so the instructions go into the
   first `session/prompt` of a new session as a block of their own. On resume the block is cut out
   of the replayed history (`devin-client.ts`).
2. **Skills among the slash commands.** Commands that Devin files under the `cognition.ai/category`
   "Skills" are marked as skills, so only those are offered mid-prompt (`command-kind.ts`). The
   wait for Devin's command list is 10 s.
3. **Additional directories.** `session/new`, `session/load` and `session/resume` carry
   `providerOptions.additionalDirectories` when the agent supports them
   (`additional-directories.ts`).
4. **Shell output in the chat.** Released ACP terminals are kept (up to 32), and their output is
   attached to the tool call that ran the same command, since Devin never puts it in the call's
   content (`acp-agent.ts`).
5. **Subagent cards.** Devin's `run_subagent` shows as a subagent card with the task, what the
   subagent ran, and its answer (`devin-subagent-card.ts`).
6. **Compaction marker.** `/compact` shows the compaction marker, and the context ring is cleared
   when it completes (`devin-compaction.ts`).
7. **Plan usage in the context hover card**, through `usageProvider: "devin"`.

### Agent runtime

8. **Idle release.** The provider process of a Claude or Devin agent that has been idle for the
   configured time (15 minutes by default) is released, and the agent resumes on its next open or
   prompt (`idle-release*.ts`, setting in `packages/app/src/irix/idle-release-setting.tsx`).
9. **Agent guide.** When a session starts, Claude and Devin are taught the `irix` command line and
   the `IRIX_RG_PATH` ripgrep search binary by a guide built from the host's settings (`agent-guide.ts`,
   `claude-agent-guide.ts`).
10. **Quoted CLI arguments on Windows.** A message split at its spaces is joined back into one
    argument (`packages/cli/src/irix/argv.ts`).
11. **Claude starts disabled when it is not installed.** The provider is switched off when its
    command is not found at daemon start; an explicit setting wins (`providers.ts`, called from
    `bootstrap.ts`).
12. **PowerShell on Windows.** Terminals and ACP shell commands use PowerShell instead of `cmd`;
    `IRIX_WINDOWS_SHELL=cmd` switches back (`windows-shell.ts`).

### GitLab and fork workflow

13. **GitLab over REST.** A gitbeaker REST client answers the `glab` command lines that upstream's
    GitLab service issues, so upstream's GitLab logic runs unchanged (`gitlab/glab-runner.ts`,
    `gitlab/rest-client.ts`).
14. **Credentials and TLS.** The token comes from the team's python-gitlab config, and the operating
    system's CA store is trusted (`gitlab/credentials.ts`, `gitlab/system-ca.ts`).
15. **Fork checkouts.**
    - With an `upstream` remote, Create merge request opens GitLab's new merge request page in the
      browser.
    - Merge request lookups go to the upstream project.
    - The background fetch also fetches `upstream`, and the source picker lists those branches as
      `main (upstream)` rows.
    - A pasted merge request or issue link of another project on the host is accepted.
16. **Merge request fixes.**
    - A merge request closed without merging no longer hides the Create button.
    - The Setup tab for a cross-project merge request appears only when the worktree has
      automation that would run.
17. **Pull request text without a model.** Title and description are drafted from the commits the
    way GitLab does it, instead of starting an agent (`pr-text.ts`).
18. **Cached remote lookups.** Remote URLs and project facts are cached, which cuts the git
    processes queued on a busy Windows daemon (`gitlab/upstream-cache.ts`).

### Web UI

19. **Comments on lines of a file.** Comment on lines or selected text in the CodeMirror source
    views and the Markdown preview, and send them to the agent as an attachment
    (`packages/app/src/irix/file-comments/`).
20. **Name + Create bar.** A new workspace or chat tab is named and created first; the chat comes
    after (`packages/app/src/irix/workspace-name.tsx`).
21. **In-app folder dialog.** Open folder browses the disk through the daemon instead of the slow
    OS dialog (`packages/app/src/irix/folder-picker-dialog.tsx`).
22. **`ui.AgentView` for plugins.** Plugins embed Paseo's own conversation view, and
    `ui.capabilities` says what the host provides.
23. **Plugin-managed projects hidden.** A project owned by a plugin (Bot Crew's `Bots`) is left out
    of the sidebar and the New workspace project list.
24. **Pinned usage refreshes on a timer.**
25. **Full build version.** The app shows the packed build's version
    (`EXPO_PUBLIC_IRIX_VERSION`), which is also the daemon's (`packages/app/src/utils/app-version.ts`).

### Bundled plugins

26. **`irix-gitlab`:** GitLab setup screen, search and clone from GitLab, Fork clone, Open in Devin,
    Open in File Explorer.
27. **`irix-devin-usage`:** Devin ACU usage and month-end forecast.
28. **`irix-claude-usage`:** monthly spend cap and forecast for enterprise Claude accounts, which
    upstream's usage source cannot read.
29. **`irix-context-hint`:** composer pill when the context window passes a threshold (50% and 75%
    by default); compact or start a new agent from it.
30. **`irix-content-search`:** content search in the Files panel (ripgrep-backed streaming search,
    regex/case/word switches, include/exclude globs, jump to line on click, bundled `rg` binary),
    and replace across files with a preview, per-line and per-file exclusion, and files that
    changed on disk skipped and reported.

### Build and delivery

31. **Brand and npm scope at pack time.** The Irix brand and the `@irix` scope are applied to a
    throwaway checkout, never committed (`irix/scripts/brand.mjs`, `rename-npm-scope.mjs`).
32. **License and attribution.** Packing adds upstream's LICENSE and a NOTICE to each package, and
    the About page gets a License row naming Paseo (`add-license.mjs`, `brand.mjs`).
33. **Packaging.** `pack-local.mjs` builds seven tarballs, and `license-audit.mjs` checks what ships.
34. **Footprint check.** `upstream-footprint.mjs` keeps the edits to upstream files within budget.
35. **CI and workspace scripts.** Workflows for checks on every push to `irix` and the weekly
    upstream sync (the publish job is switched off); `paseo.json` has Irix scripts for packing,
    verifying and probing.
36. **Windows scripts and probes.** Update, autostart and diagnostics, plus Devin ACP, MCP and usage
    probes, under `irix/scripts/`.
37. **Runs beside Paseo.** Own `irix` command, `~/.irix` home and port 6890; the CLI ignores
    `PASEO_HOME`/`PASEO_HOST` and shows its help when run with no arguments; no daemon console
    window on Windows.
38. **Web UI served by the daemon**, on by default, since Irix has no desktop app.

## B. Changes made because of company restrictions

### Network and data egress

1. **Egress guard.** The daemon connects only to loopback and an allowlist (the GitLab host,
   Devin's hosts, `api.anthropic.com`, `IRIX_ALLOWED_HOSTS`), and listens only on loopback
   (`egress-guard.ts`).
2. **Cloud features off.** Relay, pairing (links, the Pair device section, `irix pair`), Hub,
   dictation and voice mode (so no speech model downloads, no Test audio row, no `irix speech`).
3. **No upstream links.** Community and help links, the What's new row and its request are removed.
4. **No self-update.** Update daemon is refused, because it would install upstream's packages from
   npm.
5. **No connected hosts.** The daemon never dials or accepts another daemon; `irix host` and the
   `list_hosts` agent tool are gone (`connected-hosts-policy.ts`).

### Providers and forge

6. **Claude Code and Devin only.** Other providers are removed from the registry, terminal profiles
   are fixed to Claude Code, and the Providers page and Add provider catalog are hidden.
7. **Company GitLab only.** GitLab is the only forge, Add project offers Clone from GitLab in place
   of GitHub, clone requests are accepted only from the company GitLab, and `irix clone` is gone.

### Plugins

8. **Local folder plugins only.** npm, Git and registry sources are off, because they start child
   processes the guard cannot see; the plugin form says so. Only Irix's bundled plugins are built
   in.

### Agent capabilities

9. **No schedules or heartbeats.** The daemon refuses them, and the UI (sidebar row, Command
   Center), the CLI and the agent tools leave them out.
10. **No agent-to-agent messages.** A message sent by an agent is refused; a person at a terminal
    can still send.
11. **No bypass ("yolo") permission modes or auto-accept.** They are left out of the mode lists, and
    a stored bypass mode falls back to the default.
12. **Mandatory approval for subagents.** Creating or delegating to a subagent waits for a person;
    Devin's `run_subagent` is held by a `PreToolUse` hook (`subagent-approval.ts`,
    `devin-subagent-gate.ts`). The setting is locked in Settings. It also covers what an agent
    starts from its shell: `irix run` and `irix agent run` (a workspace created with an agent
    included) and the schedule operations that can start a new agent (create, resume, run once,
    and updates that change what runs, when, or for how long). The daemon asks the calling agent
    in its chat before any worktree exists, one card per request, and the CLI never reads stdin
    for an agent (`create-approval.ts`; CLI side `cli/src/irix/caller-routing.ts`). A person at a
    terminal with no calling agent still gets the prompt; with no terminal the run is refused. An agent's
    `irix run` waits 20 s, then exits asking to be run again; the request and its card stay open for ten
    minutes (`cli/src/irix/pending-run.ts`), because Devin's shell tool fails a command after 30 s.
    Claude's own Task/Agent tool asks too, through an in-process hook (the `ask` rule in settings is
    ignored where the organization allows managed rules only), and Devin's `run_subagent` hook has
    an explicit timeout. The cards read as a form (provider, model, directory, title, prompt; for
    Claude's Agent tool the subagent type and the model the agent chose, or "not set"), built by
    `approval-form.ts`.
13. **Agent tools through the CLI.** Claude and Devin get the `irix` command line instead of
    Paseo's MCP server, because a company MCP registry drops servers passed in by a client.

### Settings

14. **Hidden cards.** Update daemon, agent tools, browser tools, skills, Remove host, and adding
    terminal profiles (Restart daemon stays).
