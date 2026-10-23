// Checks whether a python-gitlab config section (or a pasted token) works against GitLab. Nothing
// here runs on its own: the setup screen calls it when the user opens the page or presses Test.

import { z } from "zod";
import {
  describeRequestError,
  gitlabApi,
  gitlabApiWithToken,
  type GitLabApi,
  type GitLabRequestError,
} from "../api.js";

export type SectionTest =
  | { result: "ok"; expiresAt: string | null; missingScopes: string[] }
  | { result: "unreachable"; detail: string }
  | { result: "token-rejected"; detail: string };

export const REQUIRED_SCOPES = ["api", "read_repository", "write_repository"] as const;

const SelfTokenSchema = z
  .object({
    active: z.boolean().optional(),
    revoked: z.boolean().optional(),
    expires_at: z.string().nullable().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .passthrough();

/** A message never carries a token: requests are sent with it in a header, not in the text. */
function detailOf(error: GitLabRequestError): string {
  return error.message.slice(0, 400);
}

/** Rejected token, or no answer at all; any other status means the probe asked the wrong question. */
function failure(error: GitLabRequestError): SectionTest | null {
  if (error.status === 401) return { result: "token-rejected", detail: detailOf(error) };
  if (error.status === null) return { result: "unreachable", detail: detailOf(error) };
  return null;
}

/**
 * Asks GitLab about the token behind `api`. A personal access token reports its own expiry and
 * scopes; any other kind of token falls back to a plain "who am I" call, which only says it works.
 */
async function probe(api: GitLabApi): Promise<SectionTest> {
  try {
    const token = SelfTokenSchema.parse(await api.PersonalAccessTokens.show({ tokenId: "self" }));
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
    const classified = failure(describeRequestError(error));
    if (classified) return classified;
  }
  try {
    await api.Users.showCurrentUser();
    return { result: "ok", expiresAt: null, missingScopes: [] };
  } catch (error) {
    const described = describeRequestError(error);
    return failure(described) ?? { result: "unreachable", detail: detailOf(described) };
  }
}

/** Tests the token a python-gitlab config section (or the environment) supplies for `url`. */
export async function testSection(
  url: string,
  section: string,
  env?: NodeJS.ProcessEnv,
): Promise<SectionTest> {
  try {
    return await probe(await gitlabApi({ url, section, env }));
  } catch (error) {
    const described = describeRequestError(error);
    return failure(described) ?? { result: "unreachable", detail: detailOf(described) };
  }
}

/** Tests a token that is not in the user's config yet; it is only held in memory. */
export function testToken(url: string, token: string): Promise<SectionTest> {
  return probe(gitlabApiWithToken(url, token));
}

export function expiresSoon(expiresAt: string | null, now: Date, days = 14): boolean {
  if (!expiresAt) return false;
  const end = new Date(`${expiresAt}T23:59:59Z`).getTime();
  return end - now.getTime() <= days * 24 * 60 * 60 * 1000;
}
