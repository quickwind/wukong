import { describe, expect, it, vi } from "vitest";

import { pickDirectoryOnDaemon } from "./pick-directory";

const noWait = { sleep: async () => {} };

function client(polls: unknown[]) {
  const invokePluginRpc = vi.fn(async (_plugin: string, method: string) =>
    method === "irix.pick-folder.start" ? { id: "d1" } : polls.shift(),
  );
  return { invokePluginRpc };
}

describe("pickDirectoryOnDaemon", () => {
  it("starts the dialog, polls while pending, and returns the chosen path", async () => {
    const rpc = client([
      { state: "pending", path: null, error: null },
      { state: "pending", path: null, error: null },
      { state: "done", path: "C:\\work\\app", error: null },
    ]);
    expect(await pickDirectoryOnDaemon(rpc, noWait)).toBe("C:\\work\\app");
    expect(rpc.invokePluginRpc).toHaveBeenNthCalledWith(
      1,
      "irix-gitlab",
      "irix.pick-folder.start",
      {},
    );
    expect(rpc.invokePluginRpc).toHaveBeenNthCalledWith(2, "irix-gitlab", "irix.pick-folder.poll", {
      id: "d1",
    });
    expect(rpc.invokePluginRpc).toHaveBeenCalledTimes(4);
  });

  it("returns null when the dialog is cancelled", async () => {
    const rpc = client([{ state: "done", path: null, error: null }]);
    expect(await pickDirectoryOnDaemon(rpc, noWait)).toBeNull();
  });

  it("raises the daemon's error when the dialog fails", async () => {
    const rpc = client([{ state: "failed", path: null, error: "No folder dialog is available." }]);
    await expect(pickDirectoryOnDaemon(rpc, noWait)).rejects.toThrow(
      "No folder dialog is available.",
    );
  });

  it("gives up if the dialog is never answered", async () => {
    const forever = {
      invokePluginRpc: vi.fn(async (_p: string, method: string) =>
        method.endsWith("start") ? { id: "d1" } : { state: "pending", path: null, error: null },
      ),
    };
    await expect(
      pickDirectoryOnDaemon(forever, { ...noWait, pollIntervalMs: 1000, giveUpAfterMs: 3000 }),
    ).rejects.toThrow(/not answered in time/);
  });

  it("fails without a connection and on a malformed answer", async () => {
    await expect(pickDirectoryOnDaemon(null)).rejects.toThrow(/Not connected/);
    const bad = { invokePluginRpc: vi.fn().mockResolvedValue({ nope: 1 }) };
    await expect(pickDirectoryOnDaemon(bad, noWait)).rejects.toThrow();
  });
});
