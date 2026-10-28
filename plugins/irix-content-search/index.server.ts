import type { PluginServerContext } from "@getpaseo/plugin/server";
import { cancelSearchRpc, pollSearchRpc, startSearchRpc } from "./shared/rpc.js";

export default function contribute(server: PluginServerContext) {
  server.handle(startSearchRpc, () => {
    throw new Error("not implemented");
  });
  server.handle(pollSearchRpc, () => {
    throw new Error("not implemented");
  });
  server.handle(cancelSearchRpc, () => {
    throw new Error("not implemented");
  });
}
