import { isAbsolute } from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  SETUP_OVERRIDE_VARIABLES,
  type setupCreateSectionRpc,
  type setupSaveRpc,
  type setupStatusRpc,
  type setupTestSectionRpc,
} from "../../shared/rpc.js";
import { expandHome } from "../config.js";
import {
  assertCfgValue,
  cfgPath,
  freeSectionName,
  readCfgSections,
  upsertSection,
} from "./cfg-file.js";
import { readGitLabSaved, writeGitLabSaved } from "./irix-json.js";
import { checkTools, expiresSoon, testSection, testToken } from "./probe.js";

function isHttps(url: string | null): url is string {
  try {
    return url !== null && new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function resolveCommand(env: NodeJS.ProcessEnv): string[] {
  const fromEnv = env.IRIX_GITLAB_COMMAND?.trim().split(/\s+/u);
  return fromEnv?.[0] ? fromEnv : (readGitLabSaved(env).command ?? ["gitlab"]);
}

/** The section's url without a trailing slash, or an error saying why it cannot be used. */
function usableSection(env: NodeJS.ProcessEnv, name: string): string {
  const section = readCfgSections(cfgPath(env)).find((entry) => entry.name === name);
  if (!section) throw new Error(`There is no section "${name}" in ${cfgPath(env)}`);
  if (!isHttps(section.url)) {
    throw new Error(`Section "${name}" needs an https url in ${cfgPath(env)}`);
  }
  return section.url.replace(/\/+$/u, "");
}

function validateUrl(value: string): string {
  assertCfgValue("GitLab URL", value);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`The GitLab URL must look like https://gitlab.example.com (got "${value}")`);
  }
  if (parsed.protocol !== "https:") throw new Error("The GitLab URL must use https");
  if (parsed.username || parsed.password) {
    throw new Error("The GitLab URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("The GitLab URL must not contain a query string or fragment");
  }
  return value.replace(/\/+$/u, "");
}

export async function setupStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RpcOutput<typeof setupStatusRpc>> {
  const path = cfgPath(env);
  return {
    tools: await checkTools(resolveCommand(env)),
    cfgPath: path,
    sections: readCfgSections(path).map(({ name, url }) => ({ name, url, usable: isHttps(url) })),
    saved: (({ url, configSection, cloneRoot }) => ({ url, configSection, cloneRoot }))(
      readGitLabSaved(env),
    ),
    overrides: SETUP_OVERRIDE_VARIABLES.filter((name) => Boolean(env[name]?.trim())),
  };
}

export async function setupTestSection(
  { section }: RpcInput<typeof setupTestSectionRpc>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RpcOutput<typeof setupTestSectionRpc>> {
  usableSection(env, section);
  const outcome = await testSection(resolveCommand(env), section, env);
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
  assertCfgValue("token", input.token);
  const path = cfgPath(env);
  const existing = readCfgSections(path).map((section) => section.name);
  const url = input.replaceSection
    ? usableSection(env, input.replaceSection)
    : validateUrl(input.url);
  const name = input.replaceSection ?? freeSectionName(existing);

  const outcome = await testToken(resolveCommand(env), url, input.token);
  if (outcome.result === "token-rejected") {
    throw new Error("GitLab rejected the token. Check that it was copied whole and has not expired.");
  }
  if (outcome.result === "unreachable") {
    throw new Error(`Could not reach ${url}: ${outcome.detail}`);
  }
  if (outcome.missingScopes.length > 0) {
    throw new Error(`The token lacks the scopes: ${outcome.missingScopes.join(", ")}`);
  }
  upsertSection(path, { name, url, token: input.token });
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
