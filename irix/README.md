# Irix

Irix is Paseo for company machines: Claude Code and Devin CLI only, the company GitLab as the
only forge, and no traffic from Paseo itself to cloud services. It is the `irix` branch of this
fork. Everything Irix adds lives in a few directories so that syncing with upstream stays cheap.

Maintainers and AI agents: read [IRIX.md](../IRIX.md) first. It holds the rules (keep upstream edits
minimal), the design decisions, the checks to run, and the known gaps. This file covers set-up.

| Where                          | What                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `packages/server/src/irix/`    | Daemon policy: egress guard, providers, plugins, GitLab adapter, clone policy         |
| `plugins/irix-gitlab/`         | Bundled plugin: GitLab setup screen, "Add project from GitLab", "Open a local folder" |
| `plugins/irix-devin-usage/`    | Bundled plugin: Devin usage queries and status                                        |
| `plugins/irix-claude-usage/`   | Bundled plugin: Claude monthly spend cap and usage windows                            |
| `packages/app/src/irix/`       | Web UI switches and the Add Project redirect                                          |
| `irix/`                        | Brand assets, brand/publish scripts (this directory)                                  |
| `irix/scripts/diagnostics/`    | Read-only Windows scripts that collect process and crash evidence                     |
| `.github/workflows/irix-*.yml` | CI checks (the publish job is off), sync with upstream                                |

Upstream files Irix touches are marked `// Irix:`: `rg "// Irix"` lists every one of them.
They are a handful of one-line hooks, not rewrites.

## What Irix does

- **No cloud traffic from the daemon.** One hook on `net.Socket#connect` refuses every
  connection that is not loopback, a local socket or a host in `IRIX_ALLOWED_HOSTS`, and the
  daemon refuses to listen on anything but loopback. That covers relay, Hub, push, registries,
  update checks and whatever upstream adds later. Child processes (the provider CLIs and `git`)
  are outside the daemon and unaffected.
- **Providers:** Claude Code and Devin CLI. Devin is a configured ACP provider (`devin acp`).
  Other providers are removed from the registry, not just disabled.
- **Windows shell:** commands agents run (Devin's `terminal/create`) and new terminals use
  PowerShell, not `cmd.exe`. Set `IRIX_WINDOWS_SHELL=cmd` in the daemon's environment to switch
  back. This is the one place to configure it (`packages/server/src/irix/windows-shell.ts`).
- **Plugins:** local directories only, plus the bundled `irix-gitlab`, `irix-devin-usage` and `irix-claude-usage`. npm, Git and registry
  installs and the other bundled plugins are off.
- **Plugins can embed Paseo's chat.** `@getpaseo/plugin/client/ui` exports `AgentView` and
  `capabilities` in Irix builds only (they are `undefined` elsewhere); see
  [Plugins: `ui.AgentView`](#plugins-uiagentview).
- **Voice:** dictation, voice mode and speech model downloads are off.
- **Web UI:** served by the daemon by default. Built with `EXPO_PUBLIC_IRIX=1`, it has no voice
  buttons, no upstream links, no What's new, no pairing-link option, and every Add Project entry
  opens the GitLab screen.

## GitLab

Put the company GitLab in `<Irix home>/irix.json` (default `~/.irix/irix.json`):

```json
{
  "gitlab": {
    "url": "https://gitlab.example.com",
    "configSection": "corp",
    "sshHost": "git.example.com:2222",
    "cloneRoot": "~/projects"
  }
}
```

`IRIX_GITLAB_URL`, `IRIX_GITLAB_SECTION`, `IRIX_GITLAB_SSH_HOST`
and `IRIX_CLONE_ROOT` take precedence (`command` and `IRIX_GITLAB_COMMAND` from earlier versions are accepted and ignored). Without `cloneRoot`, clones go to `~/workspace/gitlab` (on
Windows, `<home>\workspace\gitlab`). The URL must be https.

You normally do not edit these by hand. Open the Command Center and run **GitLab settings**, or press **GitLab settings** on the Add project from GitLab page (a built-in plugin has no row under Settings → Plugins). It checks that
lists the
sections of `~/.python-gitlab.cfg` and tests one when you press **Test**, or, with no config, takes
your GitLab URL, opens GitLab's new-token page with the name and permissions (`api`,
`read_repository`, `write_repository`) filled in, and writes the pasted token to
`~/.python-gitlab.cfg` (mode 0600, only after the token works). **Save** then writes `url`,
`configSection` and `cloneRoot` to `irix.json`. The URL always comes from the chosen section.
Irix does not keep the token: it passes through one request and ends up only in the
python-gitlab config, or in its credential helper if you configure one yourself.

The daemon's merge-request features read `irix.json` once at startup, so a changed section or URL
reaches them after the daemon restarts. Project search and clone read it on every call.

Merge request status, checks, merge, auto-merge and issues run through upstream's GitLab service.
A glab-compatible runner (`packages/server/src/irix/gitlab/glab-runner.ts`) answers the `glab`
command lines that service issues with calls to GitLab's REST API (gitbeaker, inside the daemon;
no `glab` executable and no python-gitlab process). The token is still read from the python-gitlab
config, and the system's CA store is trusted, so a company CA installed on the machine works; a
CA file can also be named by `ssl_verify` in the config section or `NODE_EXTRA_CA_CERTS`.
`ssl_verify = false` is ignored. Not supported: rebase merges. The daemon's clone request clones only from this GitLab.

## Plugins: `ui.AgentView`

A plugin screen can show Paseo's own conversation for an agent (history, streaming, composer, model,
mode and thinking pickers, permission cards, and the timeline renderers and composer pills of every installed plugin) instead of drawing a chat itself.

```tsx
import * as ui from "@getpaseo/plugin/client/ui";

const AgentView =
  typeof ui.AgentView === "function" && ui.capabilities?.agentView === 1 ? ui.AgentView : null;
// ...
return AgentView ? (
  <AgentView agentId={chat.id} serverId={host.key} workspaceId={chat.agent.workspaceId} />
) : (
  <MyOwnChatWindow />
);
```

- Props: `agentId`, `serverId`, `workspaceId` (all required) and `onOpenWorkspaceFile?(request)`;
  without the last one file links do nothing. `ui.capabilities.agentView` is `1` for these props.
- Give the parent `flex: 1` and `minHeight: 0`; the view fills it and scrolls inside. Two views, or
  one view whose `agentId` changes, do not affect each other.
- Detect it, do not compare versions: Irix's version number is not Paseo's. Types ship in
  `@irix/plugin` (`dist/client/irix-ui.d.ts`); the public `@getpaseo/plugin@0.11.2` has none, so a
  plugin built against it declares `AgentView` and `capabilities` itself.
- `ui.capabilities.managedProjectsHidden === 1`: the sidebar and New workspace leave out the project
  Bot Crew manages (`<home>/plugin-data/bot-crew/...`), so a plugin may draw its own tree of those
  workspaces. Where it is absent (Paseo, older Irix), keep using the native project.
- A sidebar item (`addSidebarHeaderItem`, Paseo 0.11 and later; 0.9.x and 0.10.x have only
  `addSidebarItem`, so test `typeof client.addSidebarHeaderItem === "function"`) can render several
  `SidebarRow`s, and runs under the plugin's own providers: `useSettings`, `useRpc`, `usePaseo`,
  `useWorkspace` and `useAgent` work, and `useQuery` uses the plugin's host-made `QueryClient`
  (shared with its screens), so a `QueryClientProvider` of its own is not needed. A row reaches a
  screen with `openScreen({ screenId })`; `addSurface("bots", ...)` registers the screen id `bots`.
  `navigation.openWorkspace/openAgent` exist on screens only, not on sidebar items.
- Not available inside it: opening subagent tracks and the import sheet. In a narrow pane the mode
  picker is hidden by upstream's layout.
- A new chat with no model chosen shows no "/" commands (upstream). For Devin, the daemon waits up to
  10 s for the command list that Devin sends after a session opens. A "/" in the middle of a message
  offers Devin's skills only: the other commands run only at the start of a message.

## Building the packages yourself

Needs Node.js 22+ and Git. Works the same on Windows (PowerShell or cmd), macOS and Linux:

```sh
git clone -b irix https://github.com/quickwind/Paseo.git irix
cd irix
node irix/scripts/pack-local.mjs            # writes to ~/irix-dist; --out <dir> to change it
```

It checks out the last commit into a throwaway folder, applies the npm scope and the brand,
installs, builds (including the web UI) and writes seven `irix-*.tgz` files to `--out`, plus
`irix-<version>.zip`: the seven tarballs with `windows-update.ps1`, `windows-autostart.ps1` and
`INSTALL-WINDOWS.md`, as one file to hand out. Nothing is published. Takes about ten minutes the first time. Then follow `irix/INSTALL-WINDOWS.md`.

- Only committed work is included. Commit your changes first.
- Tarballs of an earlier build in `--out` are removed first, so the folder always holds one build.
- `--scope acme` builds `@acme/*` instead of `@irix/*`; `--work-dir C:\wk` picks the build
  folder (keep it short on Windows); `--keep` leaves the folder in place.
- `git config core.autocrlf` may be `true` on Windows; the build copes with CRLF.

## Publishing

**The publish job is switched off.** `irix-publish.yml` runs its checks on every push to `irix`
and publishes nothing: the `publish` job has `if: ${{ false }}`. Build packages locally with
`node irix/scripts/pack-local.mjs` (see above). The rest of this section describes what the job
does once it is switched back on, by changing that condition to `${{ vars.NPM_SCOPE != '' }}`.

`irix-publish.yml` runs on every push to `irix`. It verifies, then (once `NPM_SCOPE` is set)
rewrites the npm scope and the brand in a throwaway checkout, builds with `EXPO_PUBLIC_IRIX=1`,
publishes `<version>-irix.<run>` for the seven packages and keeps the tarballs as an artifact.

1. Choose the registry and scope (GitHub Packages, npmjs or an internal registry).
2. Repository variables: `NPM_SCOPE` (required), `NPM_REGISTRY`, `NPM_ACCESS` (`restricted` by
   default).
3. Create the `npm-publish` environment and add `NPM_TOKEN` (not needed for GitHub Packages).
4. Run `irix/scripts/disable-upstream-workflows.sh <owner/repo>` once to turn off upstream
   workflows that cannot work in the fork.

Install all seven packages together, otherwise npm pulls the upstream versions from the public
registry:

```sh
npm install -g @<scope>/cli @<scope>/server @<scope>/client @<scope>/protocol @<scope>/relay \
  @<scope>/plugin @<scope>/highlight
irix daemon start        # http://127.0.0.1:6890, data in ~/.irix
```

Tag releases with a prefix other than `v` (for example `irix-20261010`): upstream's release
workflows trigger on `v*`.

## Staying in sync

`main` mirrors upstream; `irix` is `main` plus Irix. `irix-sync-upstream.yml` runs weekly,
fast-forwards `main`, merges it into a `sync/upstream-*` branch, runs the brand and Irix tests
and the typecheck, and opens a pull request. A conflict opens an issue naming the files. Run the
same merge locally with `git config rerere.enabled true` and a conflict you resolved once is
resolved the same way next time.

Three tests fail loudly when an upstream change needs attention, instead of letting a build ship
half-adapted:

- `irix/scripts/brand.test.mjs`: a brand rule no longer matches, or a replaced file changed.
- `packages/server/src/irix/gitlab/glab-runner.test.ts`: upstream changed a `glab` command line.
- `packages/server/src/irix/plugins.test.ts` and `providers.test.ts`: a hook moved.

## Not covered

- Nothing intercepts what the provider CLIs themselves send; they reach their own services.
- The egress guard does not see DNS lookups or UDP.
- Pairing links: the option is hidden in Settings, but the welcome screen and `/pair-scan` still
  accept a pasted link, which is a deliberate user action.
- Links to `paseo.sh/docs` remain; they open only when clicked.
- The GitLab integration has not been run against a live GitLab (version 19.0 in particular):
  start with auto-merge (the client sends both the old and the new parameter).
