/** Errors that the GitLab setup screen can fix: no config, no tool, or a token GitLab refuses. */
export function needsGitLabSetup(message: string): boolean {
  return /not configured|not found; install|config file not found|\b401\b|unauthorized/iu.test(
    message,
  );
}
