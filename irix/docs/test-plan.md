# Irix test plan: keeping upgrades stable

Goal: after an upstream merge, a red test tells us what upstream changed under an Irix hook, and a
green run means every Irix behaviour in [changes-from-upstream.md](changes-from-upstream.md) still
works. The v0.14.0 sync showed the gap: upstream made `daemonConfigStore.patch` async, the two Irix
wrappers kept returning plain objects, every Settings change failed, and no test noticed because the
tests used hand-written fakes shaped like the old upstream.

## Three layers

1. **Seam tests** (`packages/server/src/irix/seams.test.ts`). One test per place where Irix hooks
   an upstream member that is not part of a public contract. Each runs the Irix hook against the
   real upstream object (a real `DaemonConfigStore`, the real `ClaudeAgentClient.prototype`, a real
   `Session`), never a fake shaped like it. A failure here means "upstream changed X; look at the
   hook". The old `idle-release-*.test.ts` pins were this idea; they went with the feature.
2. **Unit tests** for every Irix-owned file, with env vars (`IRIX_*`) set and restored by the test
   itself so the result does not depend on the runner's shell.
3. **Acceptance e2e** (`packages/server/src/irix/acceptance.e2e.test.ts`, then a browser spec). Boot a
   real daemon in a temp home on its own port with the Irix policy on and check the "B" list in
   changes-from-upstream.md through the public client: only Claude and Devin, schedules refused,
   agent messages refused, connected hosts refused, update daemon refused, bypass modes filtered,
   config changes persist and read back, bundled plugins loaded. The browser spec loads the built
   web UI against that daemon: title, hidden cards, no request leaves localhost, Settings
   toggles persist.

## Rules for the tests

- No fake that mirrors an upstream signature. If a fake is unavoidable, a seam test must cover the
  real signature.
- A test sets the `IRIX_*` and `PASEO_*` variables it needs and restores them (use `vi.stubEnv`);
  it must pass with `PASEO_AGENT_ID` set and with `IRIX_*` unset.
- Run one file at a time: `npx vitest run <file>` (never a whole workspace).
- Real Claude in a test: Haiku, low thinking. No real Devin in CI.
- A test that finds a product bug is reported, not worked around; the source is not changed to
  make a test pass without saying so.

## Work split (phase 1, disjoint files)

| Track               | Files                                                                                                                                                                          | Content                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Seams            | `packages/server/src/irix/seams.test.ts`                                                                                                                                       | Config store wrappers against the real store (async `patch`, `get`, `onFieldChange`), `ClaudeAgentClient.prototype.createSession/resumeSession` argument positions, ws server `sessions` + `Session.getClientActivity`, `collectingRuntimes`/`isProtected` seam of the idle collector, provider registry restriction, forge registry, plugin compiler alias, `agentManager` members the guide and approval read |
| B. Server unit gaps | `edition.test.ts`, `gitlab/fork-scope.test.ts`, `gitlab/schemas.test.ts`, `subagent-approval-config.test.ts`                                                                   | Files with no test; the approval/agent-tools store wrappers                                                                                                                                                                                                                                                                                                                                                     |
| C. CLI and app unit | `packages/cli/src/irix/surface.test.ts`; `packages/app/src/irix/{build,managed-projects,plugin-source-field,schedules-disabled,agent-tools-setting,workspace-name}.test.ts(x)` | Commands removed per switch; hidden-by-edition components; managed project filter                                                                                                                                                                                                                                                                                                                               |
| D. Acceptance e2e   | `packages/server/src/irix/acceptance.e2e.test.ts`                                                                                                                              | Layer 3, daemon half                                                                                                                                                                                                                                                                                                                                                                                            |

## Phase 2 (in progress)

- Browser acceptance spec against the built web UI, including file comments, content search,
  folder dialog, Name + Create bar. In progress: `irix/e2e/` (Playwright config and support
  exist; the specs are being written). Run with `node irix/scripts/test-irix.mjs --browser --only browser`.
- Done: `node irix/scripts/test-irix.mjs` runs the Irix files in order, and
  `.github/workflows/irix-checks.yml` calls it (plus a non-blocking browser job). Written and
  checked locally only; neither workflow has run on GitHub.
- Done: "run `test-irix` and read the seam failures first" is in the sync SOP in `IRIX.md`.
