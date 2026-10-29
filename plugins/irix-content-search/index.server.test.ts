import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import contribute from "./index.server.js";

describe("contribute", () => {
  it("registers the three search RPCs and returns a cleanup function", () => {
    const names: string[] = [];
    const server = {
      handle: (rpc: { name: string }) => {
        names.push(rpc.name);
      },
    } as unknown as PluginServerContext;

    const cleanup = contribute(server);

    expect(names.sort()).toEqual([
      "irix.search.content.cancel",
      "irix.search.content.poll",
      "irix.search.content.start",
    ]);
    expect(typeof cleanup).toBe("function");
    expect(() => cleanup()).not.toThrow();
  });
});
