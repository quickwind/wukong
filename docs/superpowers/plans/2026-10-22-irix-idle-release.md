# Irix Idle Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On an Irix daemon, close the provider process (Devin ACP, Claude Code) of an agent that has been idle for N minutes, keep the agent itself, and let the next open or prompt resume it.

**Architecture:** Everything lives in Irix-owned files and is wired through hooks Irix already has: `attachIrixAgentManager` (called from upstream `prepareSessionConfig` on every create and resume), the Claude session factory wrapper in the same function, and `attachIrixWsServer` (called from upstream `irixServerFeatures`). A one-minute sweep calls the upstream `AgentManager.closeAgent(id)`, which keeps the agent `closed` with its timeline; `ensureAgentLoaded` resumes it on demand. No upstream file changes.

**Tech Stack:** TypeScript, vitest, React Native (app settings card).

**Spec:** No separate design document. The agreed design is the "Design" section below, from the conversation of 2026-10-21/22 (Windows devin.exe memory exhaustion investigation).

## Design (agreed with the user)

- Why: idle agents stay resident forever upstream (`docs/agent-lifecycle.md`, "Runtime residency"); on Windows each idle `devin acp` grows to 170+ MB and 31 of them exhausted a 32 GB machine.
- Providers: `claude` and `devin` (the only Irix providers). Other providers are never released.
- An agent is released only when ALL hold:
  1. setting enabled; `now - agent.updatedAt >= minutes`;
  2. `lifecycle === "idle"`, no `activeForegroundTurnId`, `pendingPermissions.size === 0`, not `internal`;
  3. no client is viewing it: some connected client's last heartbeat has `appVisible === true`, `focusedAgentId === agent.id`, and `now - lastActivityAt < minutes` (a foreground tab nobody has touched for the whole idle window does not count as viewing);
  4. Devin/ACP: no terminal entry with `released === false && exit === null` on the ACP session (`terminalEntries`, `acp-agent.ts:1750`);
  5. Claude: no running background shell (`task_started` with `task_type: "local_bash"` and no terminal `task_notification`/`task_updated` status since) and no `listProviderSubagents(id)` entry with `status === "running"`.
- Setting: daemon config key `idleRelease: { enabled: boolean, minutes: number }`, default `{ enabled: true, minutes: 15 }`, persisted in `<PASEO_HOME>/daemon.json` next to `requireSubagentApproval` (same file, same read/write style as `irix/subagent-approval.ts:20-77`), exposed through the wrapped `daemonConfigStore.get/patch` so `useDaemonConfig` reads and patches it. Changes apply on the next sweep; no restart.
- UI: a card in Settings → host → Agents, next to "Require Subagent Approval": a switch and a minutes field.
- Upstream behaviour is unchanged when Irix is not active (`isIrixActive()` false): nothing is attached.

## Global Constraints

- Zero lines changed in upstream files. `node irix/scripts/upstream-footprint.mjs` must still report 44 files / 447 lines.
- Every read of an upstream private field (`terminalEntries`, `translateMessageToEvents`, `wsServer.sessions`, `session.getClientActivity`) goes through one accessor that tolerates its absence (treat as "not busy"/"not viewed"/"cannot hook") and is pinned by a test against the real upstream class, so an upstream rename fails a test instead of silently disabling the feature.
- `minutes` accepted range: integer 1–1440. Anything else in a patch is rejected with an error; anything else read from disk falls back to 15.
- Sweep interval: 60 000 ms, timer `unref()`ed.
- Run only the test files you touch (`cd packages/server && npx vitest run src/irix/<file>.test.ts --bail=1`; app: `cd packages/app && npx vitest run src/irix/<file>.test.tsx --bail=1`). Then `npm run typecheck`, `npm run lint -- <files>`, `npm run format:files -- <files>`.

## Review Focus

1. A prompt that arrives while a release is closing the agent must be delivered once, to the resumed agent — pinned in Task 2 (`closeAgent` runs in the lifecycle lane; `ensureAgentLoaded` waits for it).
2. A client that disconnects or goes to background must stop counting as a viewer immediately — pinned in Task 4.
3. A release that fails (`closeAgent` rejects) must be logged once per agent per failure and retried on a later sweep without crashing the sweep for other agents — pinned in Task 2.
4. A released agent shows `closed`, and opening it brings back the full timeline without duplicated history — pinned in Task 2 (real `AgentManager` with fake clients).
5. Bad `minutes` on disk (string, 0, -5, 99999) must not disable or crash the daemon — pinned in Task 1.

---

## File Structure

| File                                                  | Responsibility                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/server/src/irix/idle-release-settings.ts`   | Read/validate/persist `idleRelease`; wrap `daemonConfigStore`                                       |
| `packages/server/src/irix/idle-release-busy.ts`       | "Is this agent busy?" probes: ACP terminals, Claude background shells (tracker), provider subagents |
| `packages/server/src/irix/idle-release-viewers.ts`    | Set of agent ids currently viewed, from the ws server's client activity                             |
| `packages/server/src/irix/idle-release.ts`            | `isReleasable` decision + sweep that calls `closeAgent`                                             |
| `packages/server/src/irix/subagent-approval.ts`       | (Irix file) call the three attach points from the existing hooks                                    |
| `packages/app/src/irix/idle-release-setting.tsx`      | Settings card                                                                                       |
| `packages/app/src/irix/subagent-approval-setting.tsx` | (Irix file) `irixAgentsCard` renders both cards                                                     |
| `IRIX.md`                                             | Design-decision paragraph + nothing in the upstream table (no upstream change)                      |

---

### Task 1: Settings — read, validate, persist, expose through the config store

**Files:**

- Create: `packages/server/src/irix/idle-release-settings.ts`
- Test: `packages/server/src/irix/idle-release-settings.test.ts`

**Interfaces:**

- Produces:
  - `interface IdleReleaseSettings { enabled: boolean; minutes: number }`
  - `const DEFAULT_IDLE_RELEASE: IdleReleaseSettings = { enabled: true, minutes: 15 }`
  - `function getIdleReleaseSettings(): IdleReleaseSettings` (in-memory, loaded lazily from disk)
  - `function setIdleReleaseSettings(patch: Partial<IdleReleaseSettings>, paseoHome?: string | null): IdleReleaseSettings` (throws on invalid `minutes`/`enabled`)
  - `function wrapIdleReleaseConfigStore(wsServer: { daemonConfigStore?: { get(): object; patch(p: Record<string, unknown>): object }; broadcastDaemonConfigChanged?(c: object): void }): void` — `get()` adds `idleRelease`; `patch({ idleRelease })` validates, persists, broadcasts.
  - `function resetIdleReleaseSettingsForTests(): void`

- [ ] **Step 1: Write the failing tests**
  - `reads defaults when daemon.json is missing` → `{ enabled: true, minutes: 15 }`
  - `reads a persisted value` → write `{"daemon":{"idleRelease":{"enabled":false,"minutes":30}}}` to a temp `PASEO_HOME/daemon.json`, expect `{ enabled: false, minutes: 30 }`
  - `falls back to 15 for bad minutes on disk` for each of `"15"`, `0`, `-5`, `99999`, `1.5` → minutes 15, enabled kept
  - `rejects bad minutes in a patch` → `setIdleReleaseSettings({ minutes: 0 })` throws; disk unchanged
  - `persists a patch without dropping other daemon.json keys` → existing `requireSubagentApproval: false` survives
  - `config store get/patch carry idleRelease` → fake store; `get().idleRelease` equals current; `patch({ idleRelease: { minutes: 5 } })` returns merged with `minutes: 5` and calls `broadcastDaemonConfigChanged` once; a patch without `idleRelease` does not broadcast

- [ ] **Step 2: Run, expect FAIL** (module not found)

- [ ] **Step 3: Implement** following `irix/subagent-approval.ts:20-77` (same `daemon.json` path resolution and merge-write; store under `daemon.idleRelease`). Wrap the store only once per object (WeakSet), after the subagent-approval wrapper so both chains apply.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit** `feat(irix): idle release settings in daemon config`

---

### Task 2: Release decision and sweep

**Files:**

- Create: `packages/server/src/irix/idle-release.ts`
- Test: `packages/server/src/irix/idle-release.test.ts`

**Interfaces:**

- Consumes: `getIdleReleaseSettings()` (Task 1); `isAgentBusy(manager, agent)` (Task 3); `viewedAgentIds(now, minutes)` (Task 4) — inject both as deps so this task's tests use fakes.
- Produces:
  - `const RELEASABLE_PROVIDERS = new Set(["claude", "devin"])`
  - `function isReleasable(agent: { id; provider; lifecycle; activeForegroundTurnId; pendingPermissions: { size: number }; internal?: boolean; updatedAt: Date }, ctx: { now: number; settings: IdleReleaseSettings; viewed: ReadonlySet<string>; busy: boolean }): boolean`
  - `function startIdleRelease(manager: IdleReleaseManager, deps?: { now?: () => number; intervalMs?: number; isBusy?: (agent) => boolean; viewed?: (now: number, minutes: number) => ReadonlySet<string>; logger?: { info; warn } }): () => void` — idempotent per manager (WeakMap), returns stop.
  - `async function sweepOnce(...)` exported for tests; releases sequentially, one `closeAgent` per agent, catches per agent.
  - `type IdleReleaseManager = { listAgents(): ManagedAgentLike[]; closeAgent(id: string): Promise<void>; listProviderSubagents?(id: string): { status: string }[] }`

- [ ] **Step 1: Write the failing unit tests** (pure `isReleasable`, one assertion each): releases an idle devin agent past 15 min; not at 14:59; not when disabled; not `running`/`initializing`/`error`; not with a pending permission; not `internal`; not provider `opencode`; not when viewed; not when busy.

- [ ] **Step 2: Write the failing sweep tests** with a fake manager:
  - `sweep closes only releasable agents and logs each release` (logger.info called with `{ agentId, provider, idleMinutes }`)
  - `a failing close is logged and the other agents are still released` (first `closeAgent` rejects; second agent still closed; warn logged once)
  - `does nothing when Irix is not active` (`isIrixActive()` false → `startIdleRelease` returns a no-op, no timer)

- [ ] **Step 3: Write the failing integration test** in the same file using a real `AgentManager` + `AgentStorage` (temp dir) + `createTestAgentClients()` from `../server/test-utils/fake-agent-client.js`, following `server/agent/agent-loading.test.ts:145-205`, provider `"claude"` (`createTestAgentClients()` registers fake `claude`, `codex`, `opencode` clients):
  - create agent, run one turn to idle (`startAgentRun` + `waitForAgentEvent`), advance the injected clock 16 min, `sweepOnce` → `manager.getAgent(id)` is `null` (closed) and storage record `lastStatus === "closed"`;
  - `ensureAgentLoaded(id, …)` → timeline has the same assistant messages as before, count unchanged (no duplicated history);
  - race: start `sweepOnce` and, without awaiting, `startAgentRun(manager, id, "again", …)` through `ensureAgentLoaded`; both settle; exactly one new user message in the timeline and the turn completes.

- [ ] **Step 4: Run, expect FAIL**

- [ ] **Step 5: Implement.** Sweep: `if (!isIrixActive()) return`; read settings; `viewed = deps.viewed(now, minutes)`; for each `manager.listAgents()` → `isReleasable` → `await manager.closeAgent(id)` in try/catch. Timer: `setInterval(..., 60_000).unref()`; skip a tick while the previous sweep still runs.

- [ ] **Step 6: Run, expect PASS**

- [ ] **Step 7: Commit** `feat(irix): release idle agent processes after the configured idle time`

---

### Task 3: Busy probes — ACP terminals, Claude background shells, provider subagents

**Files:**

- Create: `packages/server/src/irix/idle-release-busy.ts`
- Test: `packages/server/src/irix/idle-release-busy.test.ts`

**Interfaces:**

- Produces:
  - `function hasRunningAcpTerminal(session: unknown): boolean` — reads `session.terminalEntries` (Map); true if any value has `released === false && exit === null`. Missing/non-Map → false.
  - `function trackClaudeBackgroundShells(session: unknown): void` — wraps the instance's `translateMessageToEvents(message, ...rest)`; on `type:"system"`: `subtype:"task_started"` with `task_type === "local_bash"` adds `task_id`; `subtype:"task_notification"` removes `task_id`; `subtype:"task_updated"` with `patch.status` in `completed|failed|killed|stopped|canceled` removes it. Always calls through and returns the original result. Idempotent per session (WeakSet). Missing method → no-op.
  - `function hasRunningClaudeBackgroundShell(session: unknown): boolean`
  - `function isAgentBusy(manager: { listProviderSubagents?(id: string): { status: string }[] }, agent: { id: string; provider: string; session: unknown }): boolean` — running provider subagent OR (`devin` → ACP terminal) OR (`claude` → background shell).

- [ ] **Step 1: Write the failing tests**
  - ACP: fake `{ terminalEntries: new Map([["t", { released: false, exit: null }]]) }` → true; `exit: { exitCode: 0 }` → false; `released: true` → false; `{}` → false.
  - ACP pin (source-text, since the field is private): read `server/agent/providers/acp-agent.ts` and assert it contains `private readonly terminalEntries = new Map<string, TerminalEntry>()`, `released: boolean;` and `exit: TerminalExit | null;`.
  - Claude tracker: fake session with `translateMessageToEvents(m) { return ["ok"] }`; after `task_started` local_bash id `b1` → busy; returns `["ok"]`; after `task_notification` `b1` → not busy; `task_started` with `task_type: "local_agent"` → not busy; `task_updated` `{ status: "killed" }` clears.
  - Claude pin (source-text; `ClaudeAgentSession` is not exported): `server/agent/providers/claude/agent.ts` contains `private translateMessageToEvents(` and `this.translateMessageToEvents(message` (an instance override only works through a `this.` call).
  - `isAgentBusy`: running provider subagent → true for any provider.

- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** `feat(irix): detect running terminals and background shells before release`

---

### Task 4: Viewers from client heartbeats

**Files:**

- Create: `packages/server/src/irix/idle-release-viewers.ts`
- Test: `packages/server/src/irix/idle-release-viewers.test.ts`

**Interfaces:**

- Produces:
  - `function attachIdleReleaseWsServer(wsServer: unknown): void` — remembers the server (WeakRef-free module variable is fine: one daemon per process).
  - `function viewedAgentIds(now: number, minutes: number): ReadonlySet<string>` — iterates `wsServer.sessions` (Map of ws → `{ session }`), calls `session.getClientActivity(ws)`; includes `focusedAgentId` when `appVisible === true` and `now - lastActivityAt.getTime() < minutes * 60_000`. No server attached → empty set.

- [ ] **Step 1: Write the failing tests** with a fake `{ sessions: new Map([[ws, { session: { getClientActivity: () => activity } }]]) }`: visible+focused+recent → included; `appVisible:false` → excluded; `lastActivityAt` 16 min ago with minutes 15 → excluded; ws removed from the map (disconnect) → excluded on the next call; `focusedAgentId: null` → excluded.
- [ ] **Step 2: Pin tests:** `Session.prototype.getClientActivity` (exported class in `server/session.ts`) is a function; source-text of `server/websocket-server.ts` (class `VoiceAssistantWebSocketServer`) contains `for (const [ws, connection] of this.sessions)` and `connection.session`.
- [ ] **Step 3: Run, expect FAIL; implement; run, expect PASS**
- [ ] **Step 4: Commit** `feat(irix): treat a focused, visible chat as in use`

---

### Task 5: Wire into the existing Irix hooks

**Files:**

- Modify: `packages/server/src/irix/subagent-approval.ts` — in `attachIrixAgentManager` after the WeakSet guard: `startIdleRelease(manager, { isBusy: (a) => isAgentBusy(manager, a), viewed: viewedAgentIds, logger })`; in the Claude `createSession`/`resumeSession` wrapper after `attachClaudeSessionSubagentGate(session)`: `trackClaudeBackgroundShells(session)`; in `attachIrixWsServer` after its guard: `attachIdleReleaseWsServer(wsServer)` and `wrapIdleReleaseConfigStore(wsServer)`.
- Test: extend `packages/server/src/irix/subagent-approval.test.ts` if it exists, else add the cases to `idle-release.test.ts`.

**Interfaces:** Consumes Tasks 1–4 exactly as declared.

- [ ] **Step 1: Failing test:** calling `attachIrixAgentManager(fakeManager)` twice starts exactly one sweep (spy on `startIdleRelease` via the WeakMap behaviour: one timer); a Claude session produced by the wrapped factory has a wrapped `translateMessageToEvents`.
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS**
- [ ] **Step 3:** `node irix/scripts/upstream-footprint.mjs` → still 44 files / 447 lines.
- [ ] **Step 4: Commit** `feat(irix): turn on idle release from the existing daemon hooks`

---

### Task 6: Settings card

**Files:**

- Create: `packages/app/src/irix/idle-release-setting.tsx`
- Modify: `packages/app/src/irix/subagent-approval-setting.tsx` — `irixAgentsCard` returns a component rendering `IrixSubagentApprovalCard` then `IrixIdleReleaseCard`.
- Test: `packages/app/src/irix/idle-release-setting.test.tsx`

**Interfaces:**

- Consumes: `useDaemonConfig(serverId)` → `config.idleRelease`, `patchConfig({ idleRelease } as unknown as MutableDaemonConfigPatch)`.
- Produces: `function IrixIdleReleaseCard({ serverId }: { serverId: string }): JSX.Element | null`

Copy (fixed): title `Release idle agents`; hint when on `Close an idle Claude or Devin agent's process after {minutes} minutes. The chat stays; it reopens when you open it or send a message.`; hint when off `Idle agents keep their process until the daemon restarts.`; minutes label `Idle minutes`; testIDs `host-page-idle-release-card`, `host-page-idle-release-switch`, `host-page-idle-release-minutes`.

- [ ] **Step 1: Failing tests** (follow the closest existing app component test for `useDaemonConfig` mocking): renders the switch on with `minutes` 15 when config lacks `idleRelease`; toggling calls `patchConfig({ idleRelease: { enabled: false } })`; entering `30` and blurring calls `patchConfig({ idleRelease: { minutes: 30 } })`; entering `0` shows an inline error and does not patch; renders nothing when disconnected.
- [ ] **Step 2: Run, expect FAIL; implement** with `settingsStyles` and the input styling of `AppendSystemPromptCard` in `host-page.tsx`; follow `docs/design.md` and `docs/unistyles.md` (no `useUnistyles()`); **run, expect PASS**
- [ ] **Step 3: Commit** `feat(irix): idle release setting on the Agents settings card`

---

### Task 7: Docs and real-provider verification

**Files:**

- Modify: `IRIX.md` — one paragraph under "Design decisions": what is released, the five conditions, where the setting lives, the hooks used, and that upstream keeps idle agents resident (so this is Irix-only).

- [ ] **Step 1:** Write the paragraph (doc voice rules in `CLAUDE.md`).
- [ ] **Step 2: Real Devin + Claude check on an isolated Irix daemon** (never the main daemon): build (`npm run build:server`), start an Irix daemon with its own home and port, set `idleRelease.minutes` to 1 through the settings card or a config patch. Create one Devin and one Claude agent, let each finish a turn, close the browser tab. Within ~2 minutes: `pgrep -fl "devin.*acp"` and the Claude process for that agent disappear, the agents show `closed`. Send each a message: it resumes and answers with its earlier history visible. Repeat with the chat open and focused in a visible tab: not released. Start a Devin command that sleeps 180 s and a Claude `run_in_background` sleep: not released until they finish.
- [ ] **Step 3:** Record the observed process counts and times in the PR description.
- [ ] **Step 4: Commit** `docs(irix): idle release`
