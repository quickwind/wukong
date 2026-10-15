# Installing Irix on Windows

Irix is installed from seven npm tarballs (`irix-*.tgz`). They must be installed together.

## Before you start

- **Node.js 22 or newer** (`node --version`).
- **Git for Windows** (`git --version`).
- **Claude Code** installed and signed in (`claude --version`). Devin CLI is optional.
- **python-gitlab**, only if you want GitLab search, clone and merge requests:
  `pip install python-gitlab` (or `uv tool install python-gitlab`), then set up
  `%USERPROFILE%\.python-gitlab.cfg` as you normally would.

## Build the tarballs yourself (optional)

Instead of receiving the files, build them from the repository:

```powershell
git clone -b irix https://github.com/quickwind/Paseo.git irix
cd irix
node irix/scripts/pack-local.mjs --out ..\irix-dist
```

This takes about ten minutes the first time and leaves the seven `irix-*.tgz` files in
`..\irix-dist`. Commit first if you changed anything: only committed work is built.

## Install

The build gives you one file, `irix-<version>.zip`. It holds the seven `.tgz` packages, the
install script and this guide. Unzip it, open PowerShell in that folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\windows-update.ps1
```

That installs (or updates) everything and starts the daemon. The steps it takes are listed under
[Update or remove](#update-or-remove), and you can type them by hand instead, as below.

To install by hand, open PowerShell in the folder that holds the seven `.tgz` files.

```powershell
$env:ONNXRUNTIME_NODE_INSTALL = "skip"   # skips a large voice download Irix does not use
$files = (Get-ChildItem .\irix-*.tgz).FullName
npm install -g $files
irix --version
```

`irix --version` should print `0.11.2-irix.<number>`.

The script `windows-update.ps1` (next to this file, and in `irix/scripts/` of the source) does the
whole install or update in one go: it stops the daemon, removes the old packages, installs the seven
tarballs, and starts the daemon again. See [Update or remove](#update-or-remove).

## First run

```powershell
irix daemon start
```

Open **http://127.0.0.1:6890** in a browser.

Irix keeps to itself, so it can sit next to a Paseo you already run:

- the command is `irix` (it does not install a `paseo` command);
- its data lives in `%USERPROFILE%\.irix` (Paseo uses `%USERPROFILE%\.paseo`);
- it listens on port 6890 (Paseo uses 6767).
- it ignores the `PASEO_HOME` and `PASEO_HOST` variables that a terminal opened inside Paseo
  carries, so it never talks to Paseo's daemon by accident. To use another folder, set
  `IRIX_HOME` (or pass `--home`).

Other commands:

```powershell
irix daemon status
irix daemon stop
```

The log is `%USERPROFILE%\.irix\daemon.log`.

## Connect GitLab (optional)

Two files, both in your user folder.

**1. `%USERPROFILE%\.python-gitlab.cfg`**: python-gitlab's own settings, with your token. Irix
never sees the token.

```ini
[global]
default = corp

[corp]
url = https://gitlab.your-company.com
private_token = <your personal access token, scope: api>
api_version = 4
```

Check it works before going further: `gitlab -g corp current-user get` should print your user.

**2. `%USERPROFILE%\.irix\irix.json`**: tells Irix which GitLab and which section.
Escape backslashes in JSON.

```json
{
  "gitlab": {
    "url": "https://gitlab.your-company.com",
    "configSection": "corp",
    "cloneRoot": "D:\\projects"
  }
}
```

- `url` must be https and the same server as in `.python-gitlab.cfg`.
- `configSection` is the section name above; leave it out to use `[global] default`.
- `cloneRoot` is where "Clone from GitLab" puts projects (default `%USERPROFILE%\projects`).
- `sshHost` (optional, `host` or `host:port`) clones over ssh instead of https.

Then run `irix daemon stop` and `irix daemon start`. The file may be saved with or without a
byte order mark.

## What to try

1. **Open folder.** Add project, then **Open folder**: the Windows folder dialog should appear.
   If nothing appears, open `%USERPROFILE%\.irix\daemon.log` and look for lines starting with
   `[irix-gitlab] folder dialog`: they say whether the dialog was started and how it ended.
2. **Search for directory.** Add project, then **Search for directory**, and type a path such as
   `D:\`.
3. **A Claude Code agent.** Open a project, start a chat, send a message.
4. **A terminal.** Open a terminal in a workspace; the profile list should offer Claude Code only.
5. **GitLab** (after the step above). Add project, then **Clone from GitLab**; search, clone, and
   the project opens. A project that is not your own (a team's, or one a colleague shared with you)
   also has a **Fork clone** button: it forks the project into your own namespace, waits for GitLab
   to build the fork, clones your fork, and adds an `upstream` remote that points at the original.
   A dialog lists each step as it happens. If you already have a fork it is reused.
6. **Settings.** There should be no Pair device section, and the Providers page
   should list only Claude and Devin CLI.

If something fails, send the text of the error and the last lines of
`%USERPROFILE%\.irix\daemon.log`.

## Plugins

Plugins written for Paseo work in Irix, but they install from a **local folder only**: not from
npm, GitHub or a registry (`irix plugin install npm:...` and `github:...` are refused).

```powershell
git clone https://github.com/<owner>/<plugin> D:\plugins\<plugin>
git -C D:\plugins\<plugin> checkout <commit you reviewed>
irix plugin install D:\plugins\<plugin>
```

- Turn on **Settings > Plugins > Enable plugins** first. `install` and `add` are the same command.
- Plugin code is not sandboxed. Read it before installing and pin the commit you read.
- Irix stops its own daemon from sending data to the internet, but **a plugin runs in its own
  process, outside that guard**, and may contact whatever it likes (for example a cloud API you give
  it a key for). Install only plugins you trust, and do not give them keys for services you do not
  want your data to reach.
- Only Claude Code and Devin CLI exist as providers, so a plugin that adds a provider has no effect.
- Plugins that bundle upstream's own extras (usage readers, other providers) are not included.

### Bots, offline

`paseo-bots-<version>.zip` is the Bots plugin with everything that connects to the internet removed
(connected apps, OpenAI avatars, GitHub imports, testing of remote MCP servers). It installs without git, npm or
internet. Use the file name of the zip you were given in place of `<version>` below:

```powershell
Expand-Archive .\paseo-bots-<version>.zip -DestinationPath D:\plugins
irix plugin install D:\plugins\paseo-bots-<version>
```

Check the download first if you like: `(Get-FileHash .\paseo-bots-<version>.zip).Hash` should equal the
hash in the `.sha256` file. Skills import from a folder on the machine, not from GitHub.

**Bots on Devin.** Devin has no system prompt, so a bot's identity and soul reach it as an always-on
Devin rule: the plugin keeps `.devin/rules/bot-identity.md` in each bot's own folder, for every bot, and
refreshes it before a chat starts. Chats started from the Bots page and ordinary new chats in the bot's
workspace both pick it up. A bot with a custom working folder gets its instructions through Irix's
first-message block instead, and nothing is written into that folder. Devin truncates an always-on rule
file at 32 KiB; the plugin splits a longer identity into several files and says so on the bot's
Overview page. A chat keeps the rules it had when it was created.

**Paseo's tools in Devin (message another agent by ID, list agents, ...).** A company MCP policy makes
Devin ignore the MCP server Paseo offers, so Irix tells every new Devin chat to use the `irix`
command in its shell instead (`irix agent ls`, `irix send <id> ...`, `irix logs`, `irix run`).
Devin asks before running a command, as it does for any shell command. A Devin chat created before this
update does not know about it; start a new one. To see what your Devin does with MCP servers, run
`node devin-mcp-probe.mjs --out probe-mcp.txt`, then `devin-mcp-log.ps1` (both are in the distribution
folder).

## Run it in the background, and at sign-in

`irix daemon start` hides the daemon (no console window) and returns as soon as it is ready, so
you can close the PowerShell window afterwards. `irix daemon stop` stops it.

To start it automatically whenever you sign in, with no administrator rights, run once from the
folder that has `windows-autostart.ps1`:

```powershell
powershell -ExecutionPolicy Bypass -File .\windows-autostart.ps1 install
```

That puts a shortcut in your own Startup folder (`shell:startup`). Use `status` to check it and
`remove` to undo it. It starts when you sign in, not at boot, and stops when you sign out. If
your PC blocks running scripts, create the same shortcut by hand: press Win+R, type
`shell:startup`, add a shortcut to `cmd.exe /c irix daemon start`, and set Run to Minimized.

## Usage

**Settings -> Usage** shows your Devin ACU for the billing period (for example `9.31 / 30`), with a
bar that turns amber from 80% and red from 95%. The numbers come from the Devin CLI's own login:
Irix reads `%APPDATA%\devin\credentials.toml` and asks Devin's server the same question the
CLI's `/usage` does. Run `devin auth login` first if the page says the CLI is not signed in.

- The login is only ever sent to `server.codeium.com` or `api.devin.ai` over https. If your company
  uses another Devin host, add it with `IRIX_DEVIN_API_HOSTS` (comma separated) before starting
  the daemon; Irix's network guard opens the same hosts, so nothing else needs configuring.
- Devin has no public API for this, so it may change. If the page reports that the API may have
  changed, tell the Irix maintainers.
- The bar resets on the first of each calendar month (UTC), not on the contract end date.
- From the fourth day of a month a second row shows a month-end forecast from this month's pace:
  ☀️ plenty of room, 🌤️ on track, ⛅ tight, 🌧️ likely over, ⛈️ well over. If you already pinned
  the ACU bar to the sidebar, pin the forecast row too (click it on the Usage page). When the
  pace would use the whole allowance early, the ACU bar says when it runs out.
- Pinned usage refreshes by itself about every five and a half minutes.
- Claude usage is not shown (Claude Code sign-in is not set up for it).

## Update or remove

To update, put the new tarballs in a folder and run the script from there:

```powershell
powershell -ExecutionPolicy Bypass -File .\windows-update.ps1
powershell -ExecutionPolicy Bypass -File .\windows-update.ps1 -Path D:\irix-dist   # tarballs elsewhere
powershell -ExecutionPolicy Bypass -File .\windows-update.ps1 -DryRun             # only print the steps
```

It runs these steps, which you can also type by hand:

```powershell
irix daemon stop        # a running daemon locks its files on Windows
npm uninstall -g @irix/cli @irix/server @irix/client @irix/protocol @irix/relay @irix/plugin @irix/highlight
$env:ONNXRUNTIME_NODE_INSTALL = "skip"   # this window only; skips a large voice download Irix does not use
$files = (Get-ChildItem .\irix-*.tgz).FullName
npm install -g $files     # all seven together, so npm never fetches upstream packages
irix daemon start       # hidden, returns when ready
```

Stopping the daemon first matters most. The uninstall is a precaution against leftover files, and
the `ONNXRUNTIME_NODE_INSTALL` line only avoids a slow download; neither is required. On a first
install there is nothing to stop or remove, and the script carries on past those two steps. It stops
at once if the install itself fails, so a broken install never starts the daemon.

To remove Irix completely, stop the daemon and uninstall the packages (your data stays in
`%USERPROFILE%\.irix`):

```powershell
irix daemon stop
npm uninstall -g @irix/cli @irix/server @irix/client @irix/protocol @irix/relay @irix/plugin @irix/highlight
```
