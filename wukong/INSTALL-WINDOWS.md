# Installing Wukong on Windows

Wukong is installed from seven npm tarballs (`wukong-*.tgz`). They must be installed together.

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
git clone -b wukong https://github.com/quickwind/wukong.git
cd wukong
node wukong/scripts/pack-local.mjs --out ..\wukong-dist
```

This takes about ten minutes the first time and leaves the seven `wukong-*.tgz` files in
`..\wukong-dist`. Commit first if you changed anything: only committed work is built.

## Install

The build gives you one file, `wukong-<version>.zip`. It holds the seven `.tgz` packages, the
install script and this guide. Unzip it, open PowerShell in that folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\windows-update.ps1
```

That installs (or updates) everything and starts the daemon. The steps it takes are listed under
[Update or remove](#update-or-remove), and you can type them by hand instead, as below.

To install by hand, open PowerShell in the folder that holds the seven `.tgz` files.

```powershell
$env:ONNXRUNTIME_NODE_INSTALL = "skip"   # skips a large voice download Wukong does not use
$files = (Get-ChildItem .\wukong-*.tgz).FullName
npm install -g $files
wukong --version
```

`wukong --version` should print `0.11.2-wukong.<number>`.

The script `windows-update.ps1` (next to this file, and in `wukong/scripts/` of the source) does the
whole install or update in one go: it stops the daemon, removes the old packages, installs the seven
tarballs, and starts the daemon again. See [Update or remove](#update-or-remove).

## First run

```powershell
wukong daemon start
```

Open **http://127.0.0.1:6899** in a browser.

Wukong keeps to itself, so it can sit next to a Paseo you already run:

- the command is `wukong` (it does not install a `paseo` command);
- its data lives in `%USERPROFILE%\.wukong` (Paseo uses `%USERPROFILE%\.paseo`);
- it listens on port 6899 (Paseo uses 6767).
- it ignores the `PASEO_HOME` and `PASEO_HOST` variables that a terminal opened inside Paseo
  carries, so it never talks to Paseo's daemon by accident. To use another folder, set
  `WUKONG_HOME` (or pass `--home`).

Other commands:

```powershell
wukong daemon status
wukong daemon stop
```

The log is `%USERPROFILE%\.wukong\daemon.log`.

## Connect GitLab (optional)

Two files, both in your user folder.

**1. `%USERPROFILE%\.python-gitlab.cfg`**: python-gitlab's own settings, with your token. Wukong
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

**2. `%USERPROFILE%\.wukong\wukong.json`**: tells Wukong which GitLab and which section.
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

Then run `wukong daemon stop` and `wukong daemon start`. The file may be saved with or without a
byte order mark.

## What to try

1. **Open folder.** Add project, then **Open folder**: the Windows folder dialog should appear.
   If nothing appears, open `%USERPROFILE%\.wukong\daemon.log` and look for lines starting with
   `[wukong-gitlab] folder dialog`: they say whether the dialog was started and how it ended.
2. **Search for directory.** Add project, then **Search for directory**, and type a path such as
   `D:\`.
3. **A Claude Code agent.** Open a project, start a chat, send a message.
4. **A terminal.** Open a terminal in a workspace; the profile list should offer Claude Code only.
5. **GitLab** (after the step above). Add project, then **Clone from GitLab**; search, clone, and
   the project opens. A project that is not your own (a team's, or one a colleague shared with you)
   also has a **Fork clone** button: it forks the project into your own namespace, waits for GitLab
   to build the fork, clones your fork, and adds an `upstream` remote that points at the original.
   A dialog lists each step as it happens. If you already have a fork it is reused.
6. **Settings.** There should be no Pair device section, no Usage section, and the Providers page
   should list only Claude and Devin CLI.

If something fails, send the text of the error and the last lines of
`%USERPROFILE%\.wukong\daemon.log`.

## Plugins

Plugins written for Paseo work in Wukong, but they install from a **local folder only**: not from
npm, GitHub or a registry (`wukong plugin install npm:...` and `github:...` are refused).

```powershell
git clone https://github.com/<owner>/<plugin> D:\plugins\<plugin>
git -C D:\plugins\<plugin> checkout <commit you reviewed>
wukong plugin install D:\plugins\<plugin>
```

- Turn on **Settings > Plugins > Enable plugins** first. `install` and `add` are the same command.
- Plugin code is not sandboxed. Read it before installing and pin the commit you read.
- Wukong stops its own daemon from sending data to the internet, but **a plugin runs in its own
  process, outside that guard**, and may contact whatever it likes (for example a cloud API you give
  it a key for). Install only plugins you trust, and do not give them keys for services you do not
  want your data to reach.
- Only Claude Code and Devin CLI exist as providers, so a plugin that adds a provider has no effect.
- Plugins that bundle upstream's own extras (usage readers, other providers) are not included.

### Bots, offline

`paseo-bots-<version>.zip` is the Bots plugin with everything that connects to the internet removed
(connected apps, OpenAI avatars, GitHub imports, testing of remote MCP servers). It installs without git, npm or
internet:

```powershell
Expand-Archive .\paseo-bots-0.2.0-offline.4.zip -DestinationPath D:\plugins
wukong plugin install D:\plugins\paseo-bots-0.2.0-offline.4
```

Check the download first if you like: `(Get-FileHash .\paseo-bots-0.2.0-offline.4.zip).Hash` should equal the
hash in the `.sha256` file. Skills import from a folder on the machine, not from GitHub.

## Run it in the background, and at sign-in

`wukong daemon start` hides the daemon (no console window) and returns as soon as it is ready, so
you can close the PowerShell window afterwards. `wukong daemon stop` stops it.

To start it automatically whenever you sign in, with no administrator rights, run once from the
folder that has `windows-autostart.ps1`:

```powershell
powershell -ExecutionPolicy Bypass -File .\windows-autostart.ps1 install
```

That puts a shortcut in your own Startup folder (`shell:startup`). Use `status` to check it and
`remove` to undo it. It starts when you sign in, not at boot, and stops when you sign out. If
your PC blocks running scripts, create the same shortcut by hand: press Win+R, type
`shell:startup`, add a shortcut to `cmd.exe /c wukong daemon start`, and set Run to Minimized.

## Usage

**Settings -> Usage** shows your Devin ACU for the billing period (for example `9.31 / 30`), with a
bar that turns amber from 80% and red from 95%. The numbers come from the Devin CLI's own login:
Wukong reads `%APPDATA%\devin\credentials.toml` and asks Devin's server the same question the
CLI's `/usage` does. Run `devin auth login` first if the page says the CLI is not signed in.

- The login is only ever sent to `server.codeium.com` or `api.devin.ai` over https. If your company
  uses another Devin host, add it with `WUKONG_DEVIN_API_HOSTS` (comma separated) before starting
  the daemon; Wukong's network guard opens the same hosts, so nothing else needs configuring.
- Devin has no public API for this, so it may change. If the page reports that the API may have
  changed, tell the Wukong maintainers.
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
powershell -ExecutionPolicy Bypass -File .\windows-update.ps1 -Path D:\wukong-dist   # tarballs elsewhere
powershell -ExecutionPolicy Bypass -File .\windows-update.ps1 -DryRun                 # only print the steps
```

It runs these steps, which you can also type by hand:

```powershell
wukong daemon stop        # a running daemon locks its files on Windows
npm uninstall -g @wukong/cli @wukong/server @wukong/client @wukong/protocol @wukong/relay @wukong/plugin @wukong/highlight
$env:ONNXRUNTIME_NODE_INSTALL = "skip"   # this window only; skips a large voice download Wukong does not use
$files = (Get-ChildItem .\wukong-*.tgz).FullName
npm install -g $files     # all seven together, so npm never fetches upstream packages
wukong daemon start       # hidden, returns when ready
```

Stopping the daemon first matters most. The uninstall is a precaution against leftover files, and
the `ONNXRUNTIME_NODE_INSTALL` line only avoids a slow download; neither is required. On a first
install there is nothing to stop or remove, and the script carries on past those two steps. It stops
at once if the install itself fails, so a broken install never starts the daemon.

To remove Wukong completely, stop the daemon and uninstall the packages (your data stays in
`%USERPROFILE%\.wukong`):

```powershell
wukong daemon stop
npm uninstall -g @wukong/cli @wukong/server @wukong/client @wukong/protocol @wukong/relay @wukong/plugin @wukong/highlight
```
