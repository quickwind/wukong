# Irix build notes for agents

Read [../IRIX.md](../IRIX.md) first. This file holds what building Irix on a company Windows
machine has cost people, so the next agent does not pay for it again. It is a plain file, not
upstream's `AGENTS.md` symlink.

## Packaging on Windows

`node irix/scripts/pack-local.mjs` builds seven tarballs and a zip from the **last commit** in a
throwaway checkout, so commit first (uncommitted changes are left out). The output goes to
`~/irix-dist` unless `--out` says otherwise; one batch only, it clears the earlier tarballs there.
A full build takes about 10 minutes, longer than a foreground tool call allows (5 minutes): start
it in the background and read the log.

The command that has built successfully on a team machine:

```powershell
$env:npm_config_registry = 'https://registry.npmjs.org/'
$env:ONNXRUNTIME_NODE_INSTALL = 'skip'
$env:NODE_OPTIONS = '--max-old-space-size=4096'
$env:CI = '1'
$log = Join-Path $env:TEMP 'irix-build.log'
node irix\scripts\pack-local.mjs --work-dir "$env:TEMP\irix-build" *> $log
```

What each setting is for. A plain run with none of them also succeeded once, so try the plain
command first and reach for these when it fails:

- `npm_config_registry`: the company Artifactory answered `404` for `axios@1.13.6` during
  `npm ci` in the throwaway checkout. Setting it for that one process (never in `.npmrc`, never
  committed) uses npmjs.org instead.
- `ONNXRUNTIME_NODE_INSTALL=skip`: skips a large ONNX runtime download Irix does not use.
- `NODE_OPTIONS=--max-old-space-size=4096`: `npm ci` and the Expo web export ran out of Node heap,
  with Metro and Jest worker processes dying of out-of-memory. A second try after the machine was
  quieter also helped. There is no workers setting that worked; do not chase one.
- `CI=1`: set on the build that finally passed; Expo then does not wait for input.
- `--work-dir`: keep it short (Windows path limit), and fresh for each retry.

Check the exit code and the artifacts (`~/irix-dist`: seven `.tgz` and one `.zip`, all with the
build's timestamp), not the "task completed" notice. Then install them into a temp `--prefix`
and run `irix --version` before saying it works.

## Traps in this checkout

- **Missing dependency in a worktree.** `packages/server/package.json` declares `@gitbeaker/rest`,
  but a fresh worktree may not have it in `node_modules`, so `npm run typecheck` and the
  pre-commit hook fail with `TS2307`. Nothing is wrong with the repo. `npm install` over the whole
  workspace can hang for minutes; installing the package in a temp folder and copying it and its
  dependencies (`@gitbeaker/core`, `@gitbeaker/requester-utils`, `picomatch-browser`,
  `rate-limiter-flexible`, `xcase`) into `node_modules` fixed it without touching
  `package.json` or the lockfile. Do not skip the hook with `--no-verify`.
- **The pre-commit hook runs lint, format and a typecheck of every package** (about 45 seconds).
  A commit that appears to hang is that.
- **Windows PowerShell 5.1 and non-ASCII text.** `Get-Content -Raw` reads UTF-8 as ANSI, and
  `Set-Content -Encoding UTF8` writes a BOM, so rewriting a source file that way turns emoji and
  other non-ASCII characters into garbage (a month-end forecast icon did). Edit files with the
  editor tools, or with a Node script that reads and writes UTF-8.
- **Plugin tests run from `plugins/`**: `cd plugins; npx vitest run irix-claude-usage`. The plugin
  typecheck there also fails on `@gitbeaker/rest` in `irix-gitlab` when the dependency is missing.
