import { isAbsolute } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  SETUP_OVERRIDE_VARIABLES,
  type setupCreateSectionRpc,
  type setupSaveRpc,
  type setupStatusRpc,
  type setupTestSectionRpc,
} from "../../shared/rpc.js";
import { defaultCloneRoot, expandHome } from "../config.js";
import {
  assertCfgValue,
  cfgPath,
  freeSectionName,
  readCfgSections,
  upsertSection,
} from "./cfg-file.js";
import { readGitLabSaved, writeGitLabSaved } from "./irix-json.js";
import { expiresSoon, testSection, testToken } from "./probe.js";

// The daemon's forge config (packages/server/src/irix/gitlab/config.ts) rejects other urls and
// section names at startup, which would switch off every merge-request feature.
const SECTION_NAME = /^[^\s-]\S*$/u;

/** Why `value` cannot be the GitLab url, or null when it can. */
function urlProblem(value: string | null): string | null {
  if (!value) return "has no url";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "has an url that is not valid";
  }
  if (parsed.protocol !== "https:") return "needs an https url";
  if (parsed.username || parsed.password) return "must not have credentials in its url";
  if (parsed.search || parsed.hash) return "must not have a query string or fragment in its url";
  return null;
}

function sectionProblem(name: string, url: string | null): string | null {
  if (!SECTION_NAME.test(name)) return "has a name with spaces or a leading dash";
  return urlProblem(url);
}

/** The section's url without a trailing slash, or an error saying why it cannot be used. */
function usableSection(env: NodeJS.ProcessEnv, name: string): string {
  const section = readCfgSections(cfgPath(env)).find((entry) => entry.name === name);
  if (!section) throw new Error(`There is no section "${name}" in ${cfgPath(env)}`);
  const problem = sectionProblem(name, section.url);
  if (problem) throw new Error(`Section "${name}" ${problem} in ${cfgPath(env)}`);
  return (section.url ?? "").replace(/\/+$/u, "");
}

function validateUrl(value: string): string {
  assertCfgValue("GitLab URL", value);
  const problem = urlProblem(value);
  if (problem) throw new Error(`The GitLab URL ${problem.replace(/^has no url$/u, "is empty")}`);
  return value.replace(/\/+$/u, "");
}

export async function setupStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RpcOutput<typeof setupStatusRpc>> {
  const path = cfgPath(env);
  return {
    cfgPath: path,
    sections: readCfgSections(path).map(({ name, url }) => ({
      name,
      url,
      usable: sectionProblem(name, url) === null,
    })),
    saved: (({ url, configSection, cloneRoot }) => ({ url, configSection, cloneRoot }))(
      readGitLabSaved(env),
    ),
    overrides: SETUP_OVERRIDE_VARIABLES.filter((name) => Boolean(env[name]?.trim())),
    defaultCloneRoot: defaultCloneRoot(),
  };
}

export async function setupTestSection(
  { section }: RpcInput<typeof setupTestSectionRpc>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RpcOutput<typeof setupTestSectionRpc>> {
  const url = usableSection(env, section);
  const outcome = await testSection(url, section, env);
  if (outcome.result !== "ok") {
    return {
      result: outcome.result,
      detail: outcome.detail,
      expiresAt: null,
      expiresSoon: false,
      missingScopes: [],
    };
  }
  return {
    result: "ok",
    detail: null,
    expiresAt: outcome.expiresAt,
    expiresSoon: expiresSoon(outcome.expiresAt, new Date()),
    missingScopes: outcome.missingScopes,
  };
}

export async function setupCreateSection(
  input: RpcInput<typeof setupCreateSectionRpc>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RpcOutput<typeof setupCreateSectionRpc>> {
  const token = input.token.trim(); // a pasted token often carries a trailing space or newline
  assertCfgValue("token", token);
  const path = cfgPath(env);
  const existing = readCfgSections(path).map((section) => section.name);
  const url = input.replaceSection
    ? usableSection(env, input.replaceSection)
    : validateUrl(input.url);
  const name = input.replaceSection ?? freeSectionName(existing);

  const outcome = await testToken(url, token);
  if (outcome.result === "token-rejected") {
    throw new Error(
      "GitLab rejected the token. Check that it was copied whole and has not expired.",
    );
  }
  if (outcome.result === "unreachable") {
    throw new Error(`Could not reach ${url}: ${outcome.detail}`);
  }
  if (outcome.missingScopes.length > 0) {
    throw new Error(`The token lacks the scopes: ${outcome.missingScopes.join(", ")}`);
  }
  upsertSection(path, { name, url, token });
  return { section: name };
}

export async function setupSave(
  { section, cloneRoot }: RpcInput<typeof setupSaveRpc>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RpcOutput<typeof setupSaveRpc>> {
  const url = usableSection(env, section);
  const root = cloneRoot.trim();
  if (!root || !isAbsolute(expandHome(root))) {
    throw new Error("The clone folder must be an absolute path (or start with ~/)");
  }
  const before = readGitLabSaved(env);
  writeGitLabSaved({ url, configSection: section, cloneRoot: root }, env);
  return { url, restartNeeded: before.url !== url || before.configSection !== section };
}
