# Fork: how to use it, when it helps, and where it falls short

Training notes for people who use Irix. The technical details are in `irix/docs/agent-fork-mechanism.md`.

## In one sentence

A fork starts a new agent from an existing conversation. The new agent can use a different provider (Claude Code or Devin), model or mode. The original agent is not affected and stays where it was.

A fork does not continue the conversation. The system turns the old conversation into a text summary and puts it in front of the new agent's first message. The new agent reads that summary, not the old conversation itself. Every limit below follows from this.

## How to do it

1. Under the reply you want to fork from, find the fork icon in the footer row and click it.
2. Choose **Fork in a new tab** (opens a tab in the same workspace) or **Fork in a new workspace** (opens the New workspace screen).
3. A draft appears with a **Chat history / Previous conversation** attachment. That means the summary is attached. The model, thinking level, mode and directory start out the same as the original agent. You can change any of them, including the provider.
4. Write the first message and send it.

Things to know:

- The footer you pick decides where the summary stops. To start over from the middle of a conversation, fork from that turn's footer.
- You can fork while the agent is still working. The summary stops at the current moment and includes the part of the reply that has already appeared. The original agent is not interrupted.
- If the original agent was closed by the system after a long idle time, forking reopens it first (its status goes from `closed` to `idle`).

## When it helps

| Situation                                                                                                   | What to do                                                      |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| One provider is running out of quota (check the usage page for Claude's monthly cap or Devin's ACU)         | Fork to the other provider and carry on                         |
| The conversation has grown long and you want a clean context                                                | Fork into a new agent that carries only a text summary          |
| You want to try two approaches to the same task                                                             | Fork at the point where they diverge; each agent takes one path |
| You want a different model or mode for the next step (plan with a strong model, execute with a cheaper one) | Fork, then change the model and mode in the draft               |
| You want the same context in a separate workspace                                                           | Choose **Fork in a new workspace**                              |
| The last turn went the wrong way and you want to go back                                                    | Fork from an earlier turn and leave the later content behind    |

## Limits

### The new agent knows what was said, not what was seen

The summary contains: what you said, what the agent replied, and which tools ran and on what (a file path, command, search query or URL).

The summary does not contain:

- **Tool output.** The content of a file the agent read and the result of a command are not included.
- **Reasoning.** How the agent thought about the problem does not carry over.
- **Task lists, error messages and compaction markers.**
- **Images and attachments from the old conversation.** The summary is text only (this follows from the code and was not tested separately).

So the new agent knows that "a.ts was read" but not what it says. If it needs the content, ask it to read the file again in your first message.

Tested: an agent read a file without saying what was in it. After a fork, the new agent was asked what the file said and answered UNKNOWN.

### The summary has a size limit

The whole summary stays under 100,000 characters. When the history is longer, the oldest content is dropped and the summary starts with `[Earlier chat history omitted]`. If the newest message alone is too long, it is cut in the middle and marked `[Message truncated]`.

A longer summary takes more of the new agent's context and quota. For a very long conversation, fork from a later turn, or write the key points yourself in the first message.

### The summary appears in the first message only

Later messages do not carry it again. The new agent relies on its own conversation memory from then on and is not reminded.

### File changes are not separated

Two agents working in the same directory change the same files. **Fork in a new tab** keeps the original directory, so the original agent and the new one can both edit the same file and overwrite each other. To keep them apart, use **Fork in a new workspace**, or give them different files.

### Not every agent can be forked

- Irix has two providers, Claude Code and Devin, so a fork moves a chat between those two.
- Provider sub-agent panes are read-only and have no fork option.
- On a host that is too old, forking shows **Update the host to use this.** Update the host first.
- If the original agent used a provider that is no longer in Irix (for example a Codex agent in old data), the fork fails with `references unavailable provider`.

### Other details

- The first line of the summary says "Chat history from a previous Paseo agent". It also appears in Irix. This is expected.
- When Devin is the new agent, Irix puts its own instructions (identity, the commands it may use) in front of the summary. You cannot see this in the chat and it is not an error.

## Tips

1. **State the goal in the first message.** The summary is background. Say what you want done now and which files to read first.
2. **Ask the new agent to restate.** For example: "From the history, tell me the task as you understand it and what is already done." Check that it read the history correctly before you continue.
3. **Check that the attachment is there.** The draft should show a **Chat history** attachment. If it does not, the summary was not attached.
4. **Do not let two agents edit the same file in one directory.** For work in parallel, use a new workspace.
5. **Do not fork instead of asking a follow-up.** To keep the same agent working, send a message in the original conversation. Nothing is lost that way.

## Questions

**Does the original agent change after a fork?** No. It keeps running, or stays as it was.

**Does the new agent see messages the original agent gets later?** No. The summary is fixed at the moment of the fork. Later messages in the original are not passed on.

**Does a fork cost anything?** The new agent uses model quota as usual, and the summary also takes up context. The summary can be up to about 100,000 characters, so keep an eye on it when quota is tight.

**Can I fork from Claude to Devin, and the other way round?** Yes. All four combinations (Claude to Claude, Claude to Devin, Devin to Claude, Devin to Devin) were tested.

**Why does the new agent not remember a detail?** Check whether the detail appeared only in tool output or in the agent's reasoning. The summary carries neither. Add it to your first message if it matters.
