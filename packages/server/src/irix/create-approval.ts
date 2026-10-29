// Irix edition: human approval for agents and schedules that an agent starts over the WebSocket API
// (`irix run`, `irix agent run`, a workspace created with an agent, the `schedule/*` requests) and
// for the MCP schedule tools. The daemon decides: the request names the calling agent (the CLI reads
// it from the agent's shell and checks it with the daemon), and the card goes to that agent's chat
// through the same synthetic approval the MCP `create_agent` tool uses. Nothing is read from the
// caller's stdin. A request with no calling agent is not asked here: the CLI prompts a person at a
// terminal and refuses when there is none.

import type { Logger } from "pino";

import { formatApprovalForm, previewForApproval } from "./approval-form.js";
import { ensureUnarchivedAgentLoaded } from "../server/agent/agent-loading.js";
import type { AgentStorage } from "../server/agent/agent-storage.js";
import { assertIrixSchedulesAllowed } from "./restrictions.js";
import {
  isSubagentApprovalRequired,
  requestSyntheticSubagentApproval,
} from "./subagent-approval.js";

interface CreationSnapshotLike {
  phase: string;
  agent?: unknown;
  outcomeUnknown?: boolean;
}

interface ApprovalHost {
  agentManager?: unknown;
  agentStorage?: AgentStorage;
  logger?: Logger;
  creationService?: {
    subscribe(
      kind: "workspace" | "agent",
      key: string,
      observer: (snapshot: CreationSnapshotLike) => void,
    ): Promise<{ snapshot: CreationSnapshotLike | null; unsubscribe: () => void }>;
  };
}

let host: ApprovalHost | null = null;

/** Called from `attachIrixWsServer`: the daemon's agent store, logger and creation records. */
export function rememberIrixApprovalHost(wsServer: unknown): void {
  if (wsServer && typeof wsServer === "object") {
    host = wsServer as ApprovalHost;
  }
}

export function resetIrixApprovalHostForTests(): void {
  host = null;
  pendingQuestions.clear();
  refusals.clear();
}

/** Thrown when no person could be asked, as opposed to a person saying no. */
export class IrixApprovalUnavailableError extends Error {
  constructor(callerAgentId: string, reason: string) {
    super(`Subagent approval could not be shown to calling agent ${callerAgentId}: ${reason}`);
    this.name = "IrixApprovalUnavailableError";
  }
}

function isLoaded(agentManager: unknown, agentId: string): boolean {
  const agents = (agentManager as { agents?: Map<string, unknown> } | null)?.agents;
  return agents?.has(agentId) === true;
}

/**
 * The card needs the caller loaded. Idle release closes an agent between turns, so a script it
 * left running may ask while it is unloaded; load it the way any other request to it would.
 */
async function ensureCallerLoaded(agentManager: unknown, callerAgentId: string): Promise<void> {
  if (isLoaded(agentManager, callerAgentId)) {
    return;
  }
  if (!host?.agentStorage || !host.logger) {
    throw new IrixApprovalUnavailableError(callerAgentId, "it is not running");
  }
  try {
    await ensureUnarchivedAgentLoaded(callerAgentId, {
      agentManager: agentManager as Parameters<
        typeof ensureUnarchivedAgentLoaded
      >[1]["agentManager"],
      agentStorage: host.agentStorage,
      logger: host.logger,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new IrixApprovalUnavailableError(callerAgentId, reason);
  }
}

// A request's connection owns its pending cards: when the connection closes (the `irix` process
// was killed, for example by the agent's shell-tool timeout) nobody is left to use the answer, so
// the cards are denied and taken down instead of waiting for a click that would create an orphan.
const ownedControllers = new WeakMap<object, Set<AbortController>>();

/** Called when the connection that owns `owner` closes. */
export function cancelIrixApprovalsFor(owner: object): void {
  for (const controller of ownedControllers.get(owner) ?? []) {
    controller.abort();
  }
  ownedControllers.delete(owner);
}

async function whileOwned<T>(
  owner: object | undefined,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (!owner) {
    return run(undefined);
  }
  const controller = new AbortController();
  const set = ownedControllers.get(owner) ?? new Set<AbortController>();
  set.add(controller);
  ownedControllers.set(owner, set);
  try {
    return await run(controller.signal);
  } finally {
    set.delete(controller);
  }
}

/** Raises the card in the caller's chat and resolves to the person's answer. */
export async function askCallerForApproval(input: {
  signal?: AbortSignal;
  agentManager?: unknown;
  callerAgentId: string;
  title: string;
  reason: string;
  summary: Record<string, unknown>;
  detailText?: string;
}): Promise<boolean> {
  const agentManager = input.agentManager ?? host?.agentManager;
  if (!agentManager) {
    throw new IrixApprovalUnavailableError(input.callerAgentId, "the daemon is not ready");
  }
  await ensureCallerLoaded(agentManager, input.callerAgentId);
  return requestSyntheticSubagentApproval({
    agentManager,
    targetAgentId: input.callerAgentId,
    title: input.title,
    reason: input.reason,
    inputSummary: input.summary,
    detailText: input.detailText,
    signal: input.signal,
  });
}

// A marker JSON cannot carry. The workspace step sets it on the request's `agent` object; the
// session spreads that object into the agent step's request, so the mark reaches exactly that
// step and nothing a client sends can forge it.
const APPROVED_AT_WORKSPACE = Symbol("irix.approvedAtWorkspace");

/** The parts of a create request the card shows; a workspace request nests them under `agent`. */
interface CreateRequestShape {
  requestId?: string;
  idempotencyKey?: string;
  callerAgentId?: string;
  initialPrompt?: string;
  config?: {
    provider?: string;
    model?: string | null;
    modeId?: string | null;
    thinkingOptionId?: string | null;
    cwd?: string;
    title?: string | null;
  };
  agent?: CreateRequestShape;
  [APPROVED_AT_WORKSPACE]?: true;
}

/**
 * A resent workspace request whose agent already exists, or whose outcome the daemon cannot know,
 * creates no agent; the creation service answers it from its record. Asking again would only
 * raise a card for something that already happened.
 */
async function isAnsweredFromRecord(request: CreateRequestShape): Promise<boolean> {
  const key = request.idempotencyKey ?? request.requestId;
  if (!key || !host?.creationService) {
    return false;
  }
  const { snapshot, unsubscribe } = await host.creationService.subscribe(
    "workspace",
    key,
    () => {},
  );
  unsubscribe();
  return Boolean(
    snapshot && (snapshot.agent || snapshot.outcomeUnknown || snapshot.phase === "completed"),
  );
}

// A request with an idempotency key can outlive the connection that sent it: an agent's shell tool
// may give up on `irix run` long before a person answers (Devin's does after 30 s), so the CLI
// leaves the request open and runs the same command again to pick it up. Such a request is
// remembered under (caller, key): a repeat joins the pending question instead of raising a second
// card, and a refusal is remembered so the repeat is refused without asking again.
const PENDING_REQUEST_TTL_MS = 10 * 60 * 1000;
const pendingQuestions = new Map<string, Promise<void>>();
const refusals = new Map<string, number>();

function resumableKey(callerAgentId: string, request: CreateRequestShape): string | null {
  const key = request.idempotencyKey;
  return key ? JSON.stringify([callerAgentId, key]) : null;
}

function forgetExpiredRefusals(now: number): void {
  for (const [key, until] of refusals) {
    if (until <= now) {
      refusals.delete(key);
    }
  }
}

async function askForCreation(
  agentManager: unknown,
  callerAgentId: string,
  request: CreateRequestShape,
  key: string | null,
  owner: object | undefined,
): Promise<void> {
  const detail = request.agent ?? request;
  const provider = detail.config?.provider ?? "default";
  // A resumable request is not tied to its connection: its repeat attaches to it.
  const approved = await whileOwned(key ? undefined : owner, (signal) =>
    askCallerForApproval({
      signal,
      agentManager,
      callerAgentId,
      title: "Approve subagent creation (irix run)",
      reason: `This agent asks to start a new subagent from its shell (${provider}). Approve?`,
      summary: {
        provider,
        model: detail.config?.model ?? null,
        cwd: detail.config?.cwd ?? "workspace",
        title: detail.config?.title ?? null,
        prompt: previewForApproval(detail.initialPrompt),
      },
      detailText: formatApprovalForm([
        ["Provider", provider],
        ["Model", detail.config?.model],
        ["Mode", detail.config?.modeId],
        ["Thinking", detail.config?.thinkingOptionId],
        ["Directory", detail.config?.cwd ?? "workspace"],
        ["Title", detail.config?.title],
        ["Prompt", previewForApproval(detail.initialPrompt)],
      ]),
    }),
  );
  if (!approved) {
    if (key) {
      refusals.set(key, Date.now() + PENDING_REQUEST_TTL_MS);
    }
    throw new Error("Subagent creation was rejected by user (or timed out after 10m).");
  }
}

/**
 * "workspace" asks before the workspace exists and marks the request; "agent" skips a marked
 * request, so one request raises one card.
 */
export async function assertIrixCreateApproved(
  agentManager: unknown,
  phase: "workspace" | "agent",
  request: CreateRequestShape,
  owner?: object,
): Promise<void> {
  if (phase === "agent" && request[APPROVED_AT_WORKSPACE]) {
    return;
  }
  const callerAgentId =
    phase === "workspace"
      ? (request.callerAgentId ?? request.agent?.callerAgentId)
      : request.callerAgentId;
  if (!callerAgentId || !isSubagentApprovalRequired()) {
    return;
  }
  if (phase === "workspace" && (await isAnsweredFromRecord(request))) {
    return;
  }
  const key = resumableKey(callerAgentId, request);
  if (key) {
    forgetExpiredRefusals(Date.now());
    if (refusals.has(key)) {
      throw new Error("Subagent creation was rejected by user (or timed out after 10m).");
    }
    const pending = pendingQuestions.get(key);
    if (pending) {
      await pending;
      markApproved(phase, request);
      return;
    }
  }
  const asked = askForCreation(agentManager, callerAgentId, request, key, owner);
  if (key) {
    const forget = () => {
      pendingQuestions.delete(key);
    };
    pendingQuestions.set(key, asked);
    asked.then(forget, forget);
  }
  await asked;
  markApproved(phase, request);
}

function markApproved(phase: "workspace" | "agent", request: CreateRequestShape): void {
  if (phase === "workspace" && request.agent) {
    request.agent[APPROVED_AT_WORKSPACE] = true;
  }
}

export type IrixScheduleOperation = "create" | "resume" | "run-once" | "update";

interface StoredScheduleLike {
  status: string;
  prompt: string;
  target: { type: string };
}

export interface IrixScheduleLookup {
  inspect(id: string): Promise<StoredScheduleLike>;
}

function scheduleFields(request: ScheduleRequestShape): Array<readonly [string, unknown]> {
  const config = request.target?.config ?? request.newAgentConfig;
  return [
    ["Cadence", describeCadence(request.cadence)],
    ["Provider", config?.provider],
    ["Model", config?.model],
    ["Directory", config?.cwd],
    ["Max runs", request.maxRuns],
    ["Expires", request.expiresAt],
  ];
}

async function askForSchedule(input: {
  owner?: object;
  agentManager?: unknown;
  callerAgentId: string;
  operation: IrixScheduleOperation;
  scheduleId: unknown;
  prompt: unknown;
  /** The other fields the request sets, as label and value, for the card's form. */
  fields?: ReadonlyArray<readonly [string, unknown]>;
}): Promise<void> {
  const approved = await whileOwned(input.owner, (signal) =>
    askCallerForApproval({
      signal,
      agentManager: input.agentManager,
      callerAgentId: input.callerAgentId,
      title: `Approve schedule change (${input.operation})`,
      reason:
        "This agent asks to create or restart a schedule that starts a new subagent. Approve?",
      summary: {
        operation: input.operation,
        scheduleId: typeof input.scheduleId === "string" ? input.scheduleId : null,
        prompt: previewForApproval(input.prompt),
      },
      detailText: formatApprovalForm([
        ["Operation", input.operation],
        ["Schedule", input.scheduleId],
        ...(input.fields ?? []),
        ["Prompt", previewForApproval(input.prompt)],
      ]),
    }),
  );
  if (!approved) {
    throw new Error("Schedule change was rejected by user (or timed out after 10m).");
  }
}

/**
 * The schedule an operation acts on, when that operation can start a new agent. A schedule that
 * messages an existing agent, resuming an active one (nothing restarts) and an update that does
 * not change execution are not asked.
 */
function needsApproval(
  operation: IrixScheduleOperation,
  schedule: StoredScheduleLike,
  changesExecution: boolean,
): boolean {
  if (schedule.target.type !== "new-agent") {
    return false;
  }
  if (operation === "resume") {
    return schedule.status !== "active";
  }
  return operation !== "update" || changesExecution;
}

interface ScheduleAgentConfig {
  provider?: string;
  model?: string | null;
  cwd?: string;
}

function describeCadence(cadence: unknown): string | undefined {
  const { expression, timezone } = (cadence ?? {}) as { expression?: string; timezone?: string };
  return expression ? `${expression}${timezone ? ` (${timezone})` : ""}` : undefined;
}

interface ScheduleRequestShape {
  callerAgentId?: string;
  scheduleId?: string;
  prompt?: string;
  target?: { type: string; config?: ScheduleAgentConfig };
  cadence?: unknown;
  newAgentConfig?: ScheduleAgentConfig;
  maxRuns?: unknown;
  expiresAt?: unknown;
}

/**
 * Asks the calling agent before a `schedule/*` request that can start a new agent: creating a
 * new-agent schedule, resuming one, running it once, or changing what it runs, when, or for how
 * long. Scheduled ticks are not asked: the approval covers the schedule as it was approved.
 */
export async function assertIrixScheduleApproved(
  schedules: IrixScheduleLookup,
  operation: IrixScheduleOperation,
  request: ScheduleRequestShape,
  owner?: object,
): Promise<void> {
  const callerAgentId = request.callerAgentId;
  if (!callerAgentId || !isSubagentApprovalRequired()) {
    return;
  }
  assertIrixSchedulesAllowed(); // no card for a feature the daemon refuses
  let stored: StoredScheduleLike | null = null;
  if (operation === "create") {
    if (request.target?.type !== "new-agent") {
      return;
    }
  } else {
    stored = await schedules.inspect(request.scheduleId ?? "");
    const changesExecution =
      request.prompt !== undefined ||
      request.cadence !== undefined ||
      request.newAgentConfig !== undefined ||
      request.maxRuns !== undefined ||
      request.expiresAt !== undefined;
    if (!needsApproval(operation, stored, changesExecution)) {
      return;
    }
  }
  await askForSchedule({
    owner,
    callerAgentId,
    operation,
    scheduleId: request.scheduleId,
    prompt: request.prompt ?? stored?.prompt,
    fields: scheduleFields(request),
  });
}

const MCP_SCHEDULE_OPERATIONS: Record<string, IrixScheduleOperation> = {
  create_schedule: "create",
  resume_schedule: "resume",
  run_schedule_once: "run-once",
  update_schedule: "update",
};

const MCP_UPDATE_EXECUTION_FIELDS = [
  "cron",
  "timezone",
  "prompt",
  "maxRuns",
  "provider",
  "model",
  "mode",
  "cwd",
  "expiresIn",
  "clearExpires",
];

export function isIrixMcpScheduleTool(toolName: string): boolean {
  return Object.hasOwn(MCP_SCHEDULE_OPERATIONS, toolName);
}

/**
 * The MCP counterpart of `assertIrixScheduleApproved`. A schedule the tool will refuse (missing,
 * or one that messages an existing agent) is left to the tool's own error, so no card is raised
 * for something that cannot happen.
 */
export async function assertIrixMcpScheduleApproved(
  toolName: string,
  input: Record<string, unknown>,
  context: {
    agentManager?: unknown;
    callerAgentId?: string;
    schedules?: IrixScheduleLookup | null;
  },
): Promise<void> {
  const operation = MCP_SCHEDULE_OPERATIONS[toolName];
  if (!operation || !isSubagentApprovalRequired()) {
    return;
  }
  const changesExecution = MCP_UPDATE_EXECUTION_FIELDS.some((key) => input[key] !== undefined);
  if (operation === "update" && !changesExecution) {
    return;
  }
  let stored: StoredScheduleLike | null = null;
  if (operation !== "create") {
    if (!context.schedules || typeof input.id !== "string") {
      return;
    }
    stored = await context.schedules.inspect(input.id).catch(() => null);
    if (!stored || !needsApproval(operation, stored, changesExecution)) {
      return;
    }
  }
  if (!context.callerAgentId || !context.agentManager) {
    throw new Error(
      "Schedule change blocked: mandatory human approval requires a parent agent session.",
    );
  }
  await askForSchedule({
    agentManager: context.agentManager,
    callerAgentId: context.callerAgentId,
    operation,
    scheduleId: input.id,
    prompt: input.prompt ?? stored?.prompt,
    fields: [
      [
        "Cadence",
        input.cron
          ? `${String(input.cron)}${input.timezone ? ` (${String(input.timezone)})` : ""}`
          : undefined,
      ],
      ["Provider", input.provider],
      ["Model", input.model],
      ["Mode", input.mode],
      ["Directory", input.cwd],
      ["Max runs", input.maxRuns],
      ["Expires in", input.expiresIn],
    ],
  });
}
