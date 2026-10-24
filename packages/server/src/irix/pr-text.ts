// Irix: pull request text without a model. Upstream's "Create pull request" asks an agent to write
// the title and description, which starts a provider session for every click and took many seconds on
// a Devin-only machine.
//
// `session.ts` builds its metadata generator through `createIrixGitMetadataGenerator`. With the Irix
// policy on, the generator answers at once with an empty title and description: GitLab's new merge
// request page fills those in itself from the commits, and the API path (a checkout with no
// `upstream` remote) drafts them only when it is about to create the request, with
// `draftPullRequestTextForCheckout`, the way GitLab does:
//
// - one commit: its subject is the title and its body the description;
// - several: the branch name, tidied ("fix-login-bug" -> "Fix login bug"), is the title and the
//   commit subjects, oldest first, are the description.
//
// Commit messages are still written by the model. With the Irix policy off, nothing changes.

import type {
  GitMetadataGenerator,
  PullRequestText,
} from "../server/session/checkout/git-metadata-generator.js";
import { getCurrentBranch, listCheckoutCommits } from "../utils/checkout-git.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { isIrixActive } from "./policy.js";

const FALLBACK_TITLE = "Update changes";
const MAX_TITLE_LENGTH = 200;
const MAX_LISTED_COMMITS = 50;

/** GitLab's own wording for a branch name: dashes and underscores become spaces, first letter up. */
export function humanizeBranchName(branch: string | null): string {
  const words = (branch ?? "").replace(/[-_]+/gu, " ").trim();
  if (!words) return FALLBACK_TITLE;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`.slice(0, MAX_TITLE_LENGTH);
}

export interface PullRequestDraftInput {
  branch: string | null;
  /** Subjects of the commits the branch adds to its base, newest first. */
  subjects: string[];
  /** Body of the only commit, when there is just one. */
  singleCommitBody: string;
}

export function draftPullRequestText(input: PullRequestDraftInput): PullRequestText {
  const [only] = input.subjects;
  if (input.subjects.length === 1 && only) {
    return { title: only.slice(0, MAX_TITLE_LENGTH), body: input.singleCommitBody.trim() };
  }
  const oldestFirst = input.subjects.toReversed();
  const listed = oldestFirst.slice(0, MAX_LISTED_COMMITS).map((subject) => `- ${subject}`);
  if (oldestFirst.length > MAX_LISTED_COMMITS) {
    listed.push(`- and ${oldestFirst.length - MAX_LISTED_COMMITS} more`);
  }
  return { title: humanizeBranchName(input.branch), body: listed.join("\n") };
}

async function commitBody(cwd: string, sha: string): Promise<string> {
  const { stdout } = await runGitCommand(["log", "-1", "--format=%b", sha], { cwd });
  return stdout;
}

export async function draftPullRequestTextForCheckout(cwd: string): Promise<PullRequestText> {
  const branch = await getCurrentBranch(cwd).catch(() => null);
  try {
    const { commits } = await listCheckoutCommits({ cwd });
    const added = commits.filter((commit) => !commit.isOnBase);
    const [only] = added;
    return draftPullRequestText({
      branch,
      subjects: added.map((commit) => commit.subject),
      singleCommitBody: added.length === 1 && only ? await commitBody(cwd, only.sha) : "",
    });
  } catch {
    // Not a repository, or no base to compare with: creating the request reports that itself.
    return draftPullRequestText({ branch, subjects: [], singleCommitBody: "" });
  }
}

type CreateGitMetadataGenerator = (deps: never) => GitMetadataGenerator;

export function createIrixGitMetadataGenerator<Create extends CreateGitMetadataGenerator>(
  create: Create,
  deps: Parameters<Create>[0],
): GitMetadataGenerator {
  const upstream = create(deps);
  if (!isIrixActive()) {
    return upstream;
  }
  return {
    generateCommitMessage: (cwd) => upstream.generateCommitMessage(cwd),
    generatePullRequestText: async () => ({ title: "", body: "" }),
  };
}
