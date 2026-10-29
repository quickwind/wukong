// Irix edition: the text an approval card shows. The app draws a card's `detail` of type
// `plain_text` as a text block, so "Label: value" lines read as a form; without a `detail` it falls
// back to a JSON dump of the request's input.

const PREVIEW_LENGTH = 500;

/** The text a card shows for a prompt: the first 500 characters. */
export function previewForApproval(text: unknown): string {
  if (typeof text !== "string") {
    return "";
  }
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}...` : text;
}

function isShown(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * Rows of label and value as "Label: value" lines; empty values are left out and a multi-line value
 * continues indented. The card's font is proportional, so padding to align columns would not line up.
 */
export function formatApprovalForm(rows: ReadonlyArray<readonly [string, unknown]>): string {
  return rows
    .filter(([, value]) => isShown(value))
    .map(([label, value]) => {
      const [first = "", ...rest] = String(value).split(/\r?\n/u);
      return [`${label}: ${first}`, ...rest.map((line) => `    ${line}`)].join("\n");
    })
    .join("\n");
}

/**
 * The form for Claude's own Task/Agent tool: its input names a model only when the agent chose one
 * (for example "sonnet"). Without one Claude uses the subagent type's default, which in the runs
 * checked was the starting agent's own model; a built-in type may define another, so it is not claimed.
 */
export function describeSubagentRequest(
  input: Record<string, unknown> | undefined,
  parentModel: string | undefined,
): string {
  const chosen = typeof input?.model === "string" && input.model ? input.model : null;
  const inherited = parentModel
    ? `not set: the subagent type's default, normally this agent's (${parentModel})`
    : "not set: the subagent type's default, normally this agent's";
  return formatApprovalForm([
    ["Subagent", input?.subagent_type],
    ["Model", chosen ?? inherited],
    ["Description", input?.description],
    ["Background", input?.run_in_background],
    ["Prompt", previewForApproval(input?.prompt)],
  ]);
}
