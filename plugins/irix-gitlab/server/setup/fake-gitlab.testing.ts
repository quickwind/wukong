// Test helper: a stand-in for the python-gitlab CLI, shared by the setup tests.
import { readFileSync, writeFileSync } from "node:fs";

// A stand-in for python-gitlab. `state.self` and `state.user` are the answers to the two commands
// the probe may issue; a string is a failure message printed on stderr. It records every call.
export const FAKE_GITLAB = `
import { readFileSync, writeFileSync } from "node:fs";
const file = process.env.FAKE_GL_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const command = args.filter((a) => !a.startsWith("--")).join(" ");
const cfg = process.env.PYTHON_GITLAB_CFG ? readFileSync(process.env.PYTHON_GITLAB_CFG, "utf8") : "";
state.calls.push({ args, cfg, cfgPath: process.env.PYTHON_GITLAB_CFG, tokenInEnv: Boolean(process.env.GITLAB_PRIVATE_TOKEN) });
writeFileSync(file, JSON.stringify(state));
const answer = (value) => {
  if (typeof value === "string") { console.error(value); process.exit(1); }
  console.log(JSON.stringify(value));
};
if (args.includes("--version")) console.log("gitlab 8.6.0");
else if (command === "personal-access-token get") {
  if (state.requireToken && !cfg.includes("private_token = " + state.requireToken)) {
    console.error("Impossible to get (401: 401 Unauthorized)"); process.exit(1);
  }
  answer(state.self);
} else if (command === "current-user get") answer(state.user);
else { console.error("unexpected command: " + command); process.exit(1); }
`;


export interface FakeState {
  self: unknown;
  user: unknown;
  requireToken?: string;
  calls: { args: string[]; cfg: string; cfgPath?: string; tokenInEnv: boolean }[];
}

export function seedFake(statePath: string, partial: Partial<FakeState> = {}): void {
  const state: FakeState = {
    self: { active: true, revoked: false, expires_at: null, scopes: ["api", "read_repository", "write_repository"] },
    user: { id: 1, username: "me" },
    calls: [],
    ...partial,
  };
  writeFileSync(statePath, JSON.stringify(state));
}

export const fakeCalls = (statePath: string): FakeState["calls"] =>
  (JSON.parse(readFileSync(statePath, "utf8")) as FakeState).calls;

