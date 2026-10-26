# Agent fork

Forking starts a new agent from an existing agent's conversation. The new agent can use a different provider and model, so you can continue a Claude Code chat in Devin or the other way round.

A fork does not branch the provider's session. The daemon turns the source agent's timeline into a text summary and attaches it to the new agent's first message. The source agent keeps running untouched. Providers store their sessions in incompatible formats, so text is the only thing every provider accepts.

## What the new agent receives

One text attachment (`type: "text"`, `contextKind: "chat_history"`, title "Chat history"), built by `buildAgentForkContextAttachment` in `packages/server/src/server/agent/activity-curator.ts`:

```
<chat-history-summary>
Chat history from a previous Paseo agent.
Source agent: <title>
Source directory: <cwd>

[User] ...
[Assistant] ...
[<Tool name>] <one-line summary>
</chat-history-summary>
```

- Only user messages, assistant messages and tool calls are included. Reasoning, task lists, errors and compaction markers are left out.
- A tool call shows its name and what it acted on (a file path, command, search query or URL), cut to one line. Neither the tool's full input nor its output is included.
- The source agent and directory lines are left out when the agent has no title or directory. An agent with no history yields "No chat history to display."

### Size limit

The whole text, envelope included, stays under `MAX_FORK_CONTEXT_CHARS` (100,000 characters). When the history is longer, the oldest entries are dropped and the text starts with `[Earlier chat history omitted]`. If even the newest entry does not fit, it is cut in the middle and marked `[Message truncated]`.

### Where the history stops

- **A finished turn:** the footer of that turn passes a boundary, and the summary ends at it. The app sends a timeline cursor (`boundaryCursor`) when the host reports `agentForkContextCursor`, and the assistant message id (`boundaryMessageId`) otherwise (`packages/app/src/agent-stream/turn-boundary.ts`).
- **A turn still running:** the footer next to the progress indicator passes no boundary, and the summary holds the whole timeline up to now, including the part of the reply that has streamed so far.

The request fails if the boundary is gone, or if the checkpoint changed after it was created ("Fork from a later completed response instead").

## How a fork runs

1. The user opens the fork menu in a turn footer and picks "Fork in a new tab" or "Fork in a new workspace" (`packages/app/src/components/assistant-fork-menu.tsx`).
2. `useForkAgent` (`packages/app/src/hooks/use-fork-agent.ts`) sends `agent.fork_context.request` and stores the answer as a `chat_history` attachment on a new draft. The draft starts with the source agent's provider, directory, mode, model, thinking level and feature values. The user can change any of them, or the prompt, before sending.
3. The daemon handles the request in `handleAgentForkContextRequest` (`packages/server/src/server/session.ts`) and answers with `agent.fork_context.response`.
4. When the draft is sent, the agent is created the normal way. `buildAgentPrompt` (`packages/server/src/server/agent/prompt-attachments.ts`) puts the summary in front of the typed text, the images and the other attachments.
5. Each provider turns the blocks into its own input with `renderPromptAttachmentAsText` (Claude, Codex, OpenCode, Pi and ACP agents all do). Only the first message carries the summary.

## Gotchas

- **The source agent is loaded first.** The handler calls `ensureAgentLoaded`, which resumes an agent that was closed. In Irix that includes an agent closed by idle release, so forking one starts its provider process again. If the agent's provider is no longer registered, the fork fails with "references unavailable provider".
- **Older daemons cannot fork.** The app checks the `agentForkContext` feature; without it the fork shows "Update the host to use this." instead of calling the daemon. Provider sub-agent panes are read-only and never fork.
- **The summary is lossy.** The new agent sees what was said and which tools ran on what, not tool output or the reasoning. Say so in the prompt when the new agent needs a file's content or a command's output.

## In Irix

- The providers are Claude Code and Devin, so a fork moves a chat between those two.
- A new Devin agent gets Irix's instruction block (identity, the `irix` commands) before the summary in its first prompt (`packages/server/src/irix/devin-client.ts`). The summary header still says "a previous Paseo agent": it is server text that the brand step does not touch.
- Nothing in Irix changes how forking works. It adds no upstream edit and no code of its own.
