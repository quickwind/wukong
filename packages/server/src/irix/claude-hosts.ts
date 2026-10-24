// Hosts the Claude usage plugin asks for the signed-in account's spend cap. The plugin has its own
// allowlist for where the login may be sent; the egress guard needs the same host open, or the
// request never leaves the machine. irix-claude-usage's list must stay in sync
// (claude-hosts.test.ts checks).
export const CLAUDE_USAGE_HOSTS: readonly string[] = ["api.anthropic.com"];
