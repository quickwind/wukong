// Irix has no connected hosts: a daemon never dials another daemon and never accepts a routed
// link. The real registry is replaced with one that is always empty and refuses every change, so
// no saved host in `hosts.json` is ever started and no route can be opened.

import type { HostDirectory } from "@getpaseo/protocol/hosts";
import { ConnectedHosts, HostError } from "../server/connected-hosts/index.js";
import { isIrixConnectedHostsDisabled } from "./restrictions.js";

const DISABLED_MESSAGE = "Connected hosts are not available in Irix.";

export function createDisabledConnectedHosts(self: HostDirectory["self"]): ConnectedHosts {
  const refuse = () => Promise.reject(new HostError("HOSTS_DISABLED", DISABLED_MESSAGE));
  const overrides: Record<string, unknown> = {
    list: async (): Promise<HostDirectory> => ({ self: { ...self }, hosts: [] }),
    observe: () => () => {},
    close: async () => {},
  };
  return new Proxy({} as ConnectedHosts, {
    get: (_target, property) => {
      if (typeof property !== "string" || property === "then") return undefined;
      return overrides[property] ?? refuse;
    },
  });
}

export function createIrixConnectedHosts(
  paseoHome: string,
  self: HostDirectory["self"],
): ConnectedHosts {
  return isIrixConnectedHostsDisabled()
    ? createDisabledConnectedHosts(self)
    : new ConnectedHosts(paseoHome, self);
}
