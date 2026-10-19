// Irix edition: what this host does for providers that a plugin's server code cannot see for itself.
// Plugin servers run in a child process the daemon forks, and the child inherits the daemon's
// environment, so the answer travels there as JSON in `IRIX_HOST_CAPS` (set once at daemon start,
// see edition.ts). Stock Paseo never sets it, so a plugin reads "no" there.
//
// A plugin reads it like this:
//   const caps = JSON.parse(process.env.IRIX_HOST_CAPS ?? "{}");
//   caps.devinAdditionalDirectories === true
//
// Add a key only for something the plugin cannot find out another way, and keep every value a
// boolean: a plugin treats anything but `true` as "no".

export const IRIX_HOST_CAPS_ENV = "IRIX_HOST_CAPS";

export interface IrixHostCaps {
  /** A new Devin chat gets `config.systemPrompt` (see devin-client.ts). */
  devinSystemPrompt: boolean;
  /**
   * The host passes `providerOptions.additionalDirectories` to Devin in `session/new`,
   * `session/load` and `session/resume` (see additional-directories.ts), so those directories'
   * rules load and their files need no approval. Devin has to advertise the capability itself, and
   * the version this was checked against does.
   */
  devinAdditionalDirectories: boolean;
}

export function irixHostCaps(): IrixHostCaps {
  return { devinSystemPrompt: true, devinAdditionalDirectories: true };
}

export function irixHostCapsEnvValue(): string {
  return JSON.stringify(irixHostCaps());
}
