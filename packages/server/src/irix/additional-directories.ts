// Irix edition: a plugin that runs a chat in one directory (a project's worktree) and wants the
// agent to also work in another (a bot's own folder) hands the second one over as
// `providerOptions.additionalDirectories`, the same field Claude takes. ACP carries it in
// `session/new`, `session/load` and `session/resume`, and an agent says it understands it by listing
// `additionalDirectories` under `sessionCapabilities` in its `initialize` answer (Devin does).
// There the extra directory's rules load and its files need no approval.
//
// A bad value must not fail the chat: it is dropped with a warning and the session starts without it.

import { isAbsolute } from "node:path";
import type { Logger } from "pino";

interface AdditionalDirectoriesInput {
  providerOptions: Record<string, unknown> | undefined;
  /** What the agent said in `initialize`. */
  agentCapabilities: { sessionCapabilities?: Record<string, unknown> | null } | null;
  logger: Pick<Logger, "warn">;
}

/** The ACP session parameter to spread into `session/new`, `session/load` or `session/resume`. */
export function additionalDirectoriesParams(input: AdditionalDirectoriesInput): {
  additionalDirectories?: string[];
} {
  const requested = input.providerOptions?.additionalDirectories;
  if (requested === undefined) return {};
  if (input.agentCapabilities?.sessionCapabilities?.additionalDirectories === undefined) return {};
  if (!Array.isArray(requested)) {
    input.logger.warn(
      { additionalDirectories: requested },
      "Ignoring providerOptions.additionalDirectories: it is not a list of paths",
    );
    return {};
  }
  const directories: string[] = [];
  const dropped: unknown[] = [];
  for (const entry of requested) {
    if (typeof entry === "string" && isAbsolute(entry)) {
      if (!directories.includes(entry)) directories.push(entry);
    } else {
      dropped.push(entry);
    }
  }
  if (dropped.length > 0) {
    input.logger.warn(
      { dropped },
      "Ignoring entries of providerOptions.additionalDirectories that are not absolute paths",
    );
  }
  return directories.length > 0 ? { additionalDirectories: directories } : {};
}

/** Helper taking the ACPAgentSession instance directly to minimize upstream call site lines. */
export function irixAdditionalDirectoriesParams(session: unknown): {
  additionalDirectories?: string[];
} {
  const target = session as {
    config?: { providerOptions?: Record<string, unknown> };
    agentCapabilities?: { sessionCapabilities?: Record<string, unknown> | null } | null;
    logger?: Pick<Logger, "warn">;
  };
  return additionalDirectoriesParams({
    providerOptions: target.config?.providerOptions,
    agentCapabilities: target.agentCapabilities ?? null,
    logger: target.logger ?? console,
  });
}
