/* oxlint-disable paseo/no-sync-io -- Irix: small config/credential reads outside the request path. */
// Irix edition: global mandatory human approval for subagent creation and delegation.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentSessionConfig,
} from "../server/agent/agent-sdk-types.js";
import { agentToolsFields, wrapAgentToolsConfigStore } from "./agent-tools-setting.js";
import { rememberAgentManagerForGuide } from "./agent-tools-resume.js";
import { installClaudeSessionGate } from "./claude-session-gate.js";
import { attachIdleViewers } from "./idle-viewers.js";
import { isIrixActive } from "./policy.js";
import { isIrixRestricted } from "./restrictions.js";
import {
  describeSubagentRequest,
  formatApprovalForm,
  previewForApproval,
} from "./approval-form.js";
import {
  askCallerForApproval,
  assertIrixMcpScheduleApproved,
  isIrixMcpScheduleTool,
  type IrixScheduleLookup,
  rememberIrixApprovalHost,
} from "./create-approval.js";

export const SUBAGENT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

let runtimePaseoHome: string | null = null;
let cachedPersistedValue: boolean | null = null;

function resolveConfigFilePath(paseoHome?: string | null): string | null {
  const home = paseoHome ?? runtimePaseoHome ?? process.env.PASEO_HOME;
  if (!home || !home.trim()) {
    return null;
  }
  return path.join(home.trim(), "daemon.json");
}

/** Strips a UTF-8 BOM (PowerShell 5 `Set-Content -Encoding UTF8` writes one), like upstream. */
function readConfigText(filePath: string): string {
  return readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function readPersistedSubagentApproval(paseoHome?: string | null): boolean {
  const filePath = resolveConfigFilePath(paseoHome);
  if (!filePath || !existsSync(filePath)) {
    return true;
  }
  try {
    const raw = JSON.parse(readConfigText(filePath)) as Record<string, unknown>;
    if (typeof raw.requireSubagentApproval === "boolean") {
      return raw.requireSubagentApproval;
    }
    const daemon = raw.daemon as Record<string, unknown> | undefined;
    if (daemon && typeof daemon.requireSubagentApproval === "boolean") {
      return daemon.requireSubagentApproval;
    }
  } catch {
    // Fall back to default mandatory approval when config cannot be read.
  }
  return true;
}

function writePersistedSubagentApproval(enabled: boolean, paseoHome?: string | null): void {
  const filePath = resolveConfigFilePath(paseoHome);
  if (!filePath) {
    return;
  }
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    let current: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readConfigText(filePath));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        current = {};
      }
    }
    const daemon =
      current.daemon && typeof current.daemon === "object" && !Array.isArray(current.daemon)
        ? { ...(current.daemon as Record<string, unknown>) }
        : {};
    daemon.requireSubagentApproval = enabled;
    current.daemon = daemon;
    current.requireSubagentApproval = enabled;
    writeFileSync(filePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  } catch {
    // Keep in-memory setting even if disk persistence fails in a read-only test harness.
  }
}

export function isSubagentApprovalLocked(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isIrixActive()) {
    return false;
  }
  return isIrixRestricted("subagentApprovalControl", env);
}

export function isSubagentApprovalRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isIrixActive()) {
    return false;
  }
  if (isSubagentApprovalLocked(env)) {
    return true;
  }
  if (cachedPersistedValue === null) {
    cachedPersistedValue = readPersistedSubagentApproval();
  }
  return cachedPersistedValue;
}

export function setSubagentApprovalRequired(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isSubagentApprovalLocked(env)) {
    if (!enabled) {
      throw new Error("Mandatory subagent approval is locked and cannot be turned off.");
    }
    return true;
  }
  cachedPersistedValue = enabled;
  writePersistedSubagentApproval(enabled);
  return enabled;
}

export function resetSubagentApprovalCacheForTests(value: boolean | null = null): void {
  cachedPersistedValue = value;
}

const CLAUDE_SUBAGENT_TOOLS = ["Task", "Agent"] as const;

/**
 * When global mandatory subagent approval is enabled, injects `ask: ["Task", "Agent"]` into
 * Claude session permissions and removes them from `allowedTools`. When disabled, leaves the
 * session config untouched so it follows its own mode (e.g. ask vs bypass).
 */
export function applyIrixClaudeSubagentApprovalConfig<
  T extends {
    provider?: string;
    providerOptions?: Record<string, unknown>;
  },
>(config: T, env: NodeJS.ProcessEnv = process.env): T {
  if (!isSubagentApprovalRequired(env) || config.provider !== "claude") {
    return config;
  }
  const providerOptions =
    config.providerOptions && typeof config.providerOptions === "object"
      ? { ...config.providerOptions }
      : {};

  if (Array.isArray(providerOptions.allowedTools)) {
    providerOptions.allowedTools = providerOptions.allowedTools.filter(
      (tool) => tool !== "Task" && tool !== "Agent",
    );
  }

  const settings =
    providerOptions.settings && typeof providerOptions.settings === "object"
      ? { ...(providerOptions.settings as Record<string, unknown>) }
      : {};
  const permissions =
    settings.permissions && typeof settings.permissions === "object"
      ? { ...(settings.permissions as Record<string, unknown>) }
      : {};

  const existingAsk = Array.isArray(permissions.ask)
    ? permissions.ask.filter((entry): entry is string => typeof entry === "string")
    : [];
  const existingAllow = Array.isArray(permissions.allow)
    ? permissions.allow.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry !== "Task" && entry !== "Agent",
      )
    : undefined;

  permissions.ask = Array.from(new Set([...existingAsk, ...CLAUDE_SUBAGENT_TOOLS]));
  if (existingAllow !== undefined) {
    permissions.allow = existingAllow;
  }
  settings.permissions = permissions;
  providerOptions.settings = settings;

  config.providerOptions = providerOptions;
  return config;
}

interface PendingSyntheticApproval {
  agentId: string;
  requestId: string;
  provider: string;
  request: AgentPermissionRequest;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ManagedAgentInternal {
  id: string;
  config: AgentSessionConfig;
  pendingPermissions: Map<string, AgentPermissionRequest>;
}

interface AgentManagerInternal {
  agents?: Map<string, ManagedAgentInternal>;
  clients?: Map<string, unknown>;
  notifyAgentState?: (agentId: string) => void;
  respondToPermission: (
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ) => Promise<void>;
  cancelAgentRun?: (agentId: string) => Promise<unknown>;
  closeAgent?: (agentId: string) => Promise<void>;
}

const pendingSyntheticApprovals = new Map<string, PendingSyntheticApproval>();
const hookedAgentManagers = new WeakSet<object>();
const hookedClaudeClients = new WeakSet<object>();
const hookedClaudeSessions = new WeakSet<object>();

function settleSyntheticApproval(
  manager: AgentManagerInternal,
  requestId: string,
  response: AgentPermissionResponse,
): boolean {
  const entry = pendingSyntheticApprovals.get(requestId);
  if (!entry) {
    return false;
  }
  pendingSyntheticApprovals.delete(requestId);
  clearTimeout(entry.timer);

  const agent = manager.agents?.get(entry.agentId);
  agent?.pendingPermissions?.delete(requestId);

  // `AgentManager` has no public `emit`: the state notification is what refreshes the pending list
  // of an idle agent (without it the app kept the card, with its button spinning, until reload).
  manager.notifyAgentState?.(entry.agentId);

  entry.resolve(response.behavior === "allow");
  return true;
}

function cancelSyntheticApprovalsForAgent(manager: AgentManagerInternal, agentId: string): void {
  for (const [requestId, entry] of pendingSyntheticApprovals.entries()) {
    if (entry.agentId === agentId) {
      settleSyntheticApproval(manager, requestId, {
        behavior: "deny",
        message: "Subagent approval canceled because parent agent was interrupted or closed.",
      });
    }
  }
}

interface ClaudeHookMatcher {
  matcher?: string;
  hooks: Array<(input: unknown) => Promise<Record<string, unknown>>>;
}

/**
 * Claude starts a subagent with its Task/Agent tool without asking, and the `ask` rule Irix puts in
 * the session settings does not change that where the organization's managed settings allow only
 * managed permission rules and hooks (`allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`):
 * both are ignored there. A hook passed in-process through the SDK is not a settings hook and still
 * runs, and a PreToolUse hook that answers "ask" makes Claude call the permission handler, which
 * raises the card (tested with Claude Code 2.1.311). The hook is added to what the session builds
 * for its queries, so it applies to every turn and every resume.
 */
function addSubagentAskHook(session: Record<string, unknown>): void {
  const original = session.buildSubagentEffortHooks;
  if (typeof original !== "function") {
    return;
  }
  session.buildSubagentEffortHooks = function withSubagentAskHook(
    this: unknown,
    ...args: unknown[]
  ): Record<string, ClaudeHookMatcher[]> {
    const hooks = (original as (...a: unknown[]) => Record<string, ClaudeHookMatcher[]>).apply(
      this,
      args,
    );
    const ask: ClaudeHookMatcher = {
      matcher: "Task|Agent",
      hooks: [
        async () =>
          isSubagentApprovalRequired()
            ? {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "ask",
                  permissionDecisionReason: "Starting a subagent needs a person's approval.",
                },
              }
            : {},
      ],
    };
    return { ...hooks, PreToolUse: [ask, ...(hooks.PreToolUse ?? [])] };
  };
}

/**
 * Claude builds the card for its own Task/Agent tool and shows the tool input as JSON, with no
 * model unless the agent set one. The card's request object is shared with the session's pending
 * list, so a `detail` set here, before the event goes out, is what the app draws.
 */
function addSubagentCardDetail(session: Record<string, unknown>): void {
  const original = session.pushEvent;
  if (typeof original !== "function") {
    return;
  }
  session.pushEvent = function withSubagentCardDetail(
    this: unknown,
    event: unknown,
    ...rest: unknown[]
  ) {
    try {
      const request = (
        event as {
          type?: string;
          request?: { name?: string; input?: Record<string, unknown>; detail?: unknown };
        }
      ).request;
      if ((event as { type?: string }).type === "permission_requested" && request) {
        if (request.name === "Task" || request.name === "Agent") {
          const model = (session.config as { model?: string } | undefined)?.model;
          request.detail = {
            type: "plain_text",
            text: describeSubagentRequest(request.input, model),
          };
        }
      }
    } catch {
      // The card still shows Claude's own detail.
    }
    return (original as (...a: unknown[]) => unknown).call(this, event, ...rest);
  };
}

export function attachClaudeSessionSubagentGate(session: Record<string, unknown>): void {
  if (hookedClaudeSessions.has(session)) {
    return;
  }
  hookedClaudeSessions.add(session);

  addSubagentAskHook(session);
  addSubagentCardDetail(session);

  // Add 10-minute auto-deny timeout to Claude's handlePermissionRequest for Task/Agent tools,
  // and also enforce approval via PreToolUse hook if the session runs in bypassPermissions mode.
  const originalHandlePermission = session.handlePermissionRequest;
  if (typeof originalHandlePermission === "function") {
    session.handlePermissionRequest = async function wrappedHandlePermissionRequest(
      this: Record<string, unknown>,
      toolName: string,
      input: Record<string, unknown>,
      options: { signal?: AbortSignal; suggestions?: unknown[]; toolUseID?: string },
    ) {
      if (toolName !== "Task" && toolName !== "Agent") {
        return originalHandlePermission.call(this, toolName, input, options);
      }
      const timeoutController = new AbortController();
      const timer = setTimeout(() => {
        timeoutController.abort();
      }, SUBAGENT_APPROVAL_TIMEOUT_MS);
      timer.unref?.();

      const parentSignal = options?.signal;
      const onParentAbort = () => timeoutController.abort();
      parentSignal?.addEventListener("abort", onParentAbort, { once: true });

      try {
        return await originalHandlePermission.call(this, toolName, input, {
          ...options,
          signal: timeoutController.signal,
        });
      } catch (error) {
        if (timeoutController.signal.aborted && !parentSignal?.aborted) {
          return {
            behavior: "deny",
            message: "Subagent creation approval timed out after 10 minutes.",
          };
        }
        throw error;
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onParentAbort);
      }
    };
  }
}

function wrapClaudeClient(manager: AgentManagerInternal): void {
  const claudeClient = manager.clients?.get("claude") as Record<string, unknown> | undefined;
  if (claudeClient && typeof claudeClient === "object" && !hookedClaudeClients.has(claudeClient)) {
    hookedClaudeClients.add(claudeClient);
    for (const method of ["createSession", "resumeSession"] as const) {
      const original = claudeClient[method];
      if (typeof original === "function") {
        claudeClient[method] = async function wrappedClaudeSessionFactory(
          this: unknown,
          ...args: unknown[]
        ) {
          if (args[0] && typeof args[0] === "object") {
            applyIrixClaudeSubagentApprovalConfig(args[0] as Record<string, unknown>);
          }
          const session = await (original as (...a: unknown[]) => Promise<unknown>).apply(
            this,
            args,
          );
          if (session && typeof session === "object") {
            attachClaudeSessionSubagentGate(session as Record<string, unknown>);
          }
          return session;
        };
      }
    }
  }
}

export function attachIrixAgentManager(managerInput: unknown): void {
  if (!managerInput || typeof managerInput !== "object") {
    return;
  }
  const manager = managerInput as AgentManagerInternal;
  rememberAgentManagerForGuide(manager);
  // Runs on every create and resume (from `prepareSessionConfig`), before the client makes a
  // session. The gate sits on the client prototype, so replaced clients need nothing more.
  installClaudeSessionGate();
  // Before the manager guard: upstream `updateProviderRegistry` installs a new Claude client
  // whenever the `providers.claude` config changes, and this hook runs on every create and
  // resume (from `prepareSessionConfig`, before the client is picked), so the replacement is
  // wrapped before it makes a session. `hookedClaudeClients` keeps each client wrapped once.
  wrapClaudeClient(manager);
  if (hookedAgentManagers.has(manager)) {
    return;
  }
  hookedAgentManagers.add(manager);

  const originalRespond = manager.respondToPermission.bind(manager);
  manager.respondToPermission = async (
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> => {
    if (settleSyntheticApproval(manager, requestId, response)) {
      return;
    }
    return originalRespond(agentId, requestId, response);
  };

  // Upstream's interrupt path is `cancelAgentRun` (Session.interruptAgentIfRunning calls it).
  if (typeof manager.cancelAgentRun === "function") {
    const originalCancel = manager.cancelAgentRun.bind(manager);
    manager.cancelAgentRun = async (agentId: string): Promise<unknown> => {
      cancelSyntheticApprovalsForAgent(manager, agentId);
      return originalCancel(agentId);
    };
  }

  if (typeof manager.closeAgent === "function") {
    const originalClose = manager.closeAgent.bind(manager);
    manager.closeAgent = async (agentId: string): Promise<void> => {
      cancelSyntheticApprovalsForAgent(manager, agentId);
      return originalClose(agentId);
    };
  }
}

export async function requestSyntheticSubagentApproval(input: {
  agentManager: unknown;
  targetAgentId: string;
  title: string;
  reason: string;
  inputSummary: Record<string, unknown>;
  timeoutMs?: number;
  /** Aborting (the requester went away) denies the request and takes the card down. */
  signal?: AbortSignal;
  /** What the card shows instead of a JSON dump of `inputSummary` (see approval-form.ts). */
  detailText?: string;
}): Promise<boolean> {
  attachIrixAgentManager(input.agentManager);
  const manager = input.agentManager as AgentManagerInternal;
  const agent = manager.agents?.get(input.targetAgentId);
  if (!agent) {
    return false;
  }

  const requestId = `irix-subagent-approval-${randomUUID()}`;
  const provider = agent.config?.provider ?? "claude";
  const request: AgentPermissionRequest = {
    id: requestId,
    provider,
    name: "SpawnSubagent",
    kind: "other",
    title: input.title,
    description: input.reason,
    input: input.inputSummary,
    ...(input.detailText
      ? { detail: { type: "plain_text" as const, text: input.detailText } }
      : {}),
  };

  agent.pendingPermissions.set(requestId, request);

  const timeoutMs = input.timeoutMs ?? SUBAGENT_APPROVAL_TIMEOUT_MS;
  const promise = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      settleSyntheticApproval(manager, requestId, {
        behavior: "deny",
        message: "Subagent approval timed out after 10 minutes.",
      });
    }, timeoutMs);
    timer.unref?.();

    pendingSyntheticApprovals.set(requestId, {
      agentId: input.targetAgentId,
      requestId,
      provider,
      request,
      resolve,
      timer,
    });
  });

  const onAbort = () =>
    settleSyntheticApproval(manager, requestId, {
      behavior: "deny",
      message: "Subagent approval canceled because the requester went away.",
    });
  if (input.signal?.aborted) {
    onAbort();
  } else {
    input.signal?.addEventListener("abort", onAbort, { once: true });
  }

  manager.notifyAgentState?.(input.targetAgentId);

  return promise;
}

const hookedToolMaps = new WeakSet<object>();

export function attachIrixPaseoToolsGate(
  toolsMap: unknown,
  options: {
    agentManager?: unknown;
    callerAgentId?: string;
    paseoHome?: string;
    scheduleService?: IrixScheduleLookup | null;
  },
): void {
  if (options?.paseoHome) {
    runtimePaseoHome = options.paseoHome;
  }
  if (options?.agentManager) {
    attachIrixAgentManager(options.agentManager);
  }
  if (!toolsMap || typeof toolsMap !== "object" || hookedToolMaps.has(toolsMap)) {
    return;
  }
  hookedToolMaps.add(toolsMap);

  const map = toolsMap as Map<
    string,
    {
      name: string;
      handler: (
        input: Record<string, unknown>,
        context?: { callerAgentId?: string },
      ) => Promise<unknown>;
    }
  >;
  const originalSet = map.set.bind(map);
  map.set = (key, value) => {
    if (key === "create_agent" && value && typeof value.handler === "function") {
      const originalHandler = value.handler;
      value = {
        ...value,
        handler: async (input, context) => {
          if (isSubagentApprovalRequired()) {
            const parentAgentId = context?.callerAgentId ?? options?.callerAgentId;
            if (!parentAgentId || !options?.agentManager) {
              throw new Error(
                "Subagent creation blocked: mandatory human approval requires a parent agent session.",
              );
            }
            const approved = await askCallerForApproval({
              agentManager: options.agentManager,
              callerAgentId: parentAgentId,
              title: "Approve subagent creation (create_agent)",
              reason: `This agent asks to start a new subagent (${String(input.provider ?? "default")}). Approve?`,
              summary: {
                provider: input.provider ?? "default",
                cwd: input.cwd ?? input.workspaceId ?? "workspace",
                title: input.title ?? null,
                prompt: previewForApproval(input.prompt),
              },
              detailText: formatApprovalForm([
                ["Provider", input.provider ?? "default"],
                ["Mode", input.mode],
                ["Directory", input.cwd ?? input.workspaceId ?? "workspace"],
                ["Title", input.title],
                ["Prompt", previewForApproval(input.prompt)],
              ]),
            });
            if (!approved) {
              throw new Error("Subagent creation was rejected by user (or timed out after 10m).");
            }
          }
          return originalHandler(input, context);
        },
      };
    }
    if (isIrixMcpScheduleTool(key) && value && typeof value.handler === "function") {
      const scheduleHandler = value.handler;
      value = {
        ...value,
        handler: async (input, context) => {
          await assertIrixMcpScheduleApproved(key, input, {
            agentManager: options?.agentManager,
            callerAgentId: context?.callerAgentId ?? options?.callerAgentId,
            schedules: options?.scheduleService,
          });
          return scheduleHandler(input, context);
        },
      };
    }
    return originalSet(key, value);
  };
}

interface WsServerInternal {
  paseoHome?: string;
  daemonConfigStore?: {
    get: () => Record<string, unknown>;
    patch: (
      patch: Record<string, unknown>,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  };
  agentManager?: unknown;
  broadcastCapabilitiesUpdate?: () => void;
  broadcastDaemonConfigChanged?: (config: unknown) => void;
}

const hookedWsServers = new WeakSet<object>();

export function attachIrixWsServer(wsServerInput: unknown): void {
  if (!wsServerInput || typeof wsServerInput !== "object") {
    return;
  }
  const wsServer = wsServerInput as WsServerInternal;
  if (wsServer.paseoHome) {
    runtimePaseoHome = wsServer.paseoHome;
  }
  attachIdleViewers(wsServer);
  installClaudeSessionGate();
  if (wsServer.agentManager) {
    attachIrixAgentManager(wsServer.agentManager);
  }
  rememberIrixApprovalHost(wsServer);
  if (hookedWsServers.has(wsServer)) {
    return;
  }
  hookedWsServers.add(wsServer);

  const store = wsServer.daemonConfigStore;
  if (store && typeof store.get === "function" && typeof store.patch === "function") {
    const originalGet = store.get.bind(store);
    const originalPatch = store.patch.bind(store);

    store.get = () => {
      const base = originalGet();
      return {
        ...base,
        requireSubagentApproval: isSubagentApprovalRequired(),
        subagentApprovalLocked: isSubagentApprovalLocked(),
      };
    };

    store.patch = async (patch: Record<string, unknown>) => {
      if (typeof patch.requireSubagentApproval === "boolean") {
        setSubagentApprovalRequired(patch.requireSubagentApproval);
      }
      const updated = await originalPatch(patch);
      const merged = {
        ...updated,
        requireSubagentApproval: isSubagentApprovalRequired(),
        subagentApprovalLocked: isSubagentApprovalLocked(),
      };
      if (typeof patch.requireSubagentApproval === "boolean") {
        wsServer.broadcastCapabilitiesUpdate?.();
        wsServer.broadcastDaemonConfigChanged?.(merged);
      }
      return merged;
    };
  }

  // After the approval wrapper above so both chains compose.
  if (isIrixActive()) {
    wrapAgentToolsConfigStore(wsServer);
    wrapDaemonConfigBroadcast(wsServer);
  }
}

/**
 * Upstream `daemonConfigStore.onChange` broadcasts the store's own config, which has no Irix
 * fields, and the app replaces its cached config with what it receives. The handler calls
 * `this.broadcastDaemonConfigChanged`, so an instance property shadows the private method.
 */
function wrapDaemonConfigBroadcast(wsServer: WsServerInternal): void {
  const original = wsServer.broadcastDaemonConfigChanged;
  if (typeof original !== "function") {
    return;
  }
  const bound = original.bind(wsServer);
  wsServer.broadcastDaemonConfigChanged = (config: unknown) => {
    const base = config && typeof config === "object" ? config : {};
    bound({
      ...base,
      requireSubagentApproval: isSubagentApprovalRequired(),
      subagentApprovalLocked: isSubagentApprovalLocked(),
      ...agentToolsFields(),
    });
  };
}
