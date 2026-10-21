// Irix edition: a provider can say that one of the commands it advertises is a skill, and a skill
// also works in the middle of a message (upstream offers only the skills there). ACP itself has no
// such distinction, so upstream treats every command as a plain one.
//
// Devin is the provider that says it: it files the skills under the "Skills" category in the
// command's `_meta`, under Cognition's namespace. No other provider writes that key, so every
// other command stays a plain command and the ACP providers we do not run are unaffected.
//
// The ACP session cannot tell which provider it belongs to (every ACP client registers under the
// "acp" sentinel, and the provider id is applied above the session), so the marker in the command
// is the only signal available where the list is mapped.

const DEVIN_SKILLS_CATEGORY = "Skills";

interface CommandWithMeta {
  _meta?: Record<string, unknown> | null;
}

export function irixCommandKind(command: CommandWithMeta): "command" | "skill" {
  return command._meta?.["cognition.ai/category"] === DEVIN_SKILLS_CATEGORY ? "skill" : "command";
}
