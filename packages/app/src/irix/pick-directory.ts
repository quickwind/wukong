import { z } from "zod";

const PLUGIN_ID = "irix-gitlab";
const START_METHOD = "irix.pick-folder.start";
const POLL_METHOD = "irix.pick-folder.poll";
const POLL_INTERVAL_MS = 500;
const GIVE_UP_AFTER_MS = 10 * 60 * 1000;

const StartSchema = z.object({ id: z.string() });
const PollSchema = z.object({
  state: z.enum(["pending", "done", "failed"]),
  path: z.string().nullable(),
  error: z.string().nullable(),
});

interface PluginRpcClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}

export interface PickDirectoryOptions {
  title?: string;
  pollIntervalMs?: number;
  giveUpAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Asks the daemon to show the system folder dialog. The web UI cannot: a browser never reveals a
 * folder's real path, and the daemon, which listens on this machine only, can. The daemon allows a
 * plugin RPC 30 seconds, far less than choosing a folder takes, so this starts the dialog with one
 * call and polls for the answer with short ones. Returns null when the user cancels.
 */
export async function pickDirectoryOnDaemon(
  client: PluginRpcClient | null,
  options: PickDirectoryOptions = {},
): Promise<string | null> {
  if (!client) {
    throw new Error("Not connected to the daemon.");
  }
  const sleep = options.sleep ?? defaultSleep;
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const giveUpAfter = options.giveUpAfterMs ?? GIVE_UP_AFTER_MS;

  const started = StartSchema.parse(
    await client.invokePluginRpc(
      PLUGIN_ID,
      START_METHOD,
      options.title ? { title: options.title } : {},
    ),
  );
  let waited = 0;
  while (waited <= giveUpAfter) {
    const poll = PollSchema.parse(
      await client.invokePluginRpc(PLUGIN_ID, POLL_METHOD, { id: started.id }),
    );
    if (poll.state === "done") return poll.path;
    if (poll.state === "failed") throw new Error(poll.error ?? "The folder dialog failed.");
    await sleep(interval);
    waited += interval;
  }
  throw new Error("The folder dialog was not answered in time.");
}
