# Irix browser e2e

Playwright specs that load the real Irix web UI (built with `EXPO_PUBLIC_IRIX=1`) from a real Irix
daemon and check the behaviour listed in `irix/docs/changes-from-upstream.md`. Upstream's
`packages/app/e2e` starts Metro and tests the upstream-flavoured app, so it cannot do this. Run
this after every upstream merge.

## Run

From the repo root:

```bash
npx playwright test -c irix/e2e/playwright.config.ts
npx playwright test -c irix/e2e/playwright.config.ts irix/e2e/specs/shell.spec.ts   # one spec
```

The first run builds the server, the CLI and the web UI (about 2.5 minutes). Later runs reuse the
builds and take well under a minute.

## What it starts

`global-setup.ts`:

1. Builds when needed. `npm run build:server` runs when a `dist` marker (server, supervisor, CLI)
   is older than the newest non-test source of the packages that feed it. `npm run build:daemon-web-ui`
   with `EXPO_PUBLIC_IRIX=1` runs when `.output/web-ui-stamp` is missing or older than the app,
   protocol, client or highlight sources. It writes `packages/server/dist/server/web-ui`, where the
   daemon serves the UI from. The web build gets a private, empty `TMPDIR` so Metro's shared
   transform cache cannot serve a stale `EXPO_PUBLIC_*` value.
2. Creates a temp home (`mkdtemp`) with a `config.json` that listens on `127.0.0.1:<free port>`.
3. Starts `node packages/cli/bin/irix daemon run --home <home>` as a child process, with the
   environment cleared of every `PASEO_*`, `IRIX_*` and `CLAUDE_CODE_*` variable except `PASEO_HOME`
   and `IRIX_HOME`, and waits until the page answers.
4. Writes `.output/daemon-state.json` (URL, port, home, pid) and sets `IRIX_E2E_BASE_URL`.

`global-teardown.ts` stops the PID it started (and the PID in the temp home's `paseo.pid`), then
removes the temp home. It never kills by name.

## Switches

| Variable                  | Effect                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `IRIX_E2E_SKIP_BUILD=1`   | Never build. Fails later if there is no build.                                                                                          |
| `IRIX_E2E_REBUILD=1`      | Rebuild the server, the CLI and the web UI even when they look fresh.                                                                   |
| `IRIX_E2E_KEEP_HOME=1`    | Keep the temp home after the run (logs: `<home>/daemon.log`).                                                                           |
| `IRIX_E2E_TITLE=Irix`     | Expected page title. Default `Paseo`: the brand is applied only at pack time (`irix/scripts/brand.mjs`), not in the source this builds. |
| `IRIX_E2E_CHROMIUM=<bin>` | Browser executable. By default the Playwright one, else the newest Chromium in the Playwright cache.                                    |

## Debug

```bash
npx playwright test -c irix/e2e/playwright.config.ts --headed
npx playwright test -c irix/e2e/playwright.config.ts --ui
npx playwright show-trace irix/e2e/.output/test-results/<test>/trace.zip
```

Failures leave a trace and a screenshot in `irix/e2e/.output/test-results/`. The daemon's stdout is in
`irix/e2e/.output/daemon.log`. `.output/` is git-ignored.

## Rules

- Irix e2e never touches ports 6767 (Paseo) or 6890 (Irix) or the real homes (`~/.paseo`,
  `~/.irix`). It uses a temp home and a free port, and the daemon's environment is built from
  scratch.
- No real Claude or Devin. These specs need no agent.
- A spec that finds a product bug stays red and is reported; do not weaken it to pass.
- Prefer `testID`s and roles over text. React Native Web renders `testID` as `data-testid`, and a
  Switch as a `role="switch"` element with `aria-checked` and `aria-disabled`.
- Do not edit `packages/app/e2e`; it belongs to upstream.

## One run at a time

`irix/e2e/.output/` and the daemon state file are shared by every run in a checkout. Two runs at
once (two terminals, or an agent and a person) overwrite each other's state: one run's teardown
removes the file and stops the daemon the other is using, and a stopped run can leave its
`irix daemon run` process behind. Start the suite only when no other run is going. Leftover
daemons are recognisable by `--home .../irix-e2e-*` in their command line; stop one by its PID,
never by name.
