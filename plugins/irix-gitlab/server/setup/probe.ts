// Checks the python-gitlab tooling and whether a config section works. Nothing here runs on its
// own: the setup screen calls it when the user opens the page or presses Test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { run } from "../gitlab.js";
import { upsertSection } from "./cfg-file.js";

export interface ToolStatus {
  gitlab: { found: boolean; version: string | null };
  uv: { found: boolean };
}

export type SectionTest =
  | { result: "ok"; expiresAt: string | null; missingScopes: string[] }
  | { result: "unreachable"; detail: string }
  | { result: "token-rejected"; detail: string };

export const REQUIRED_SCOPES = ["api", "read_repository", "write_repository"] as const;

const AUTH_FAILURE = /\b401\b|unauthorized/iu;
const NETWORK_FAILURE =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed? ?out|SSL|certificate|getaddrinfo|Name or service not known|Failed to resolve|Max retries exceeded|Connection(Error| refused)/iu;

async function versionOf(file: string, args: string[]): Promise<string | null> {
  try {
    return (await run(file, args)).trim() || null;
  } catch {
    return null;
  }
}

export async function checkTools(command: string[]): Promise<ToolStatus> {
  const [file = "gitlab", ...prefix] = command;
  const [gitlabVersion, uvVersion] = await Promise.all([
    versionOf(file, [...prefix, "--version"]),
    versionOf("uv", ["--version"]),
  ]);
  return {
    gitlab: { found: gitlabVersion !== null, version: gitlabVersion },
    uv: { found: uvVersion !== null },
  };
}

const SelfTokenSchema = z
  .object({
    active: z.boolean().optional(),
    revoked: z.boolean().optional(),
    expires_at: z.string().nullable().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .passthrough();

/** Python-gitlab and requests messages can echo a request; never pass a token on in a message. */
function detailOf(error: unknown): string {
  const message = (error as Error).message ?? String(error);
  return message.replace(/private_token\S*/giu, "private_token=***").slice(0, 400);
}

function failure(error: unknown): SectionTest | null {
  const message = detailOf(error);
  if (AUTH_FAILURE.test(message)) return { result: "token-rejected", detail: message };
  if (NETWORK_FAILURE.test(message)) return { result: "unreachable", detail: message };
  return null;
}

/**
 * Asks GitLab about the token behind `section`. A personal access token reports its own expiry and
 * scopes; any other kind of token falls back to a plain "who am I" call, which only says it works.
 */
export async function testSection(
  command: string[],
  section: string,
  env?: NodeJS.ProcessEnv,
): Promise<SectionTest> {
  const [file = "gitlab", ...prefix] = command;
  const base = [...prefix, "--output=json", `--gitlab=${section}`];
  try {
    const token = SelfTokenSchema.parse(
      JSON.parse(await run(file, [...base, "personal-access-token", "get", "--id=self"], env)),
    );
    if (token.revoked === true || token.active === false) {
      return { result: "token-rejected", detail: "The token is revoked or has expired" };
    }
    const scopes = token.scopes ?? [];
    return {
      result: "ok",
      expiresAt: token.expires_at ?? null,
      missingScopes: REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope)),
    };
  } catch (error) {
    const classified = failure(error);
    if (classified) return classified;
  }
  try {
    await run(file, [...base, "current-user", "get"], env);
    return { result: "ok", expiresAt: null, missingScopes: [] };
  } catch (error) {
    return failure(error) ?? { result: "unreachable", detail: detailOf(error) };
  }
}

/**
 * Tests a token that is not in the user's config yet. It goes into a throwaway config file
 * (python-gitlab only reads tokens from its config or its own environment), which is deleted after.
 */
export async function testToken(
  command: string[],
  url: string,
  token: string,
): Promise<SectionTest> {
  const directory = mkdtempSync(join(tmpdir(), "irix-gitlab-"));
  const cfg = join(directory, "python-gitlab.cfg");
  try {
    upsertSection(cfg, { name: "irix-test", url, token });
    return await testSection(command, "irix-test", { ...process.env, PYTHON_GITLAB_CFG: cfg });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function expiresSoon(expiresAt: string | null, now: Date, days = 14): boolean {
  if (!expiresAt) return false;
  const end = new Date(`${expiresAt}T23:59:59Z`).getTime();
  return end - now.getTime() <= days * 24 * 60 * 60 * 1000;
}
