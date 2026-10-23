// Irix: company GitLab servers are usually signed by a company CA that is installed in the
// operating system's trust store (Windows certificate store, macOS keychain, /etc/ssl) and not in
// Node's bundled list. Node reads the system store only when asked, so the daemon adds it to its
// default trust once. `fetch` and every other TLS connection in the process then accept it.
// NODE_EXTRA_CA_CERTS keeps working: Node folds it into the default list at startup.

import { readFileSync } from "node:fs";
import tls from "node:tls";

// The repo's @types/node predates these two functions (Node 22.15).
interface CaStore {
  getCACertificates?: (type: "default" | "system" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certificates: string[]) => void;
}
const store = tls as unknown as CaStore;

let installed = false;

export interface SystemCaOptions {
  /** PEM files to trust in addition, for example python-gitlab's `ssl_verify = /path/ca.pem`. */
  extraFiles?: string[];
}

/** Adds the system CAs (and `extraFiles`) to Node's default trust. Safe to call more than once. */
export function installSystemCa(options: SystemCaOptions = {}): void {
  const extra = (options.extraFiles ?? []).map((file) => readFileSync(file, "utf8"));
  // The functions exist from Node 22.15; on older Node there is nothing to install.
  const { getCACertificates, setDefaultCACertificates } = store;
  if (typeof getCACertificates !== "function" || typeof setDefaultCACertificates !== "function") {
    return;
  }
  if (installed && extra.length === 0) {
    return;
  }
  const merged = new Set<string>([
    ...getCACertificates("default"),
    ...getCACertificates("system"),
    ...extra,
  ]);
  setDefaultCACertificates([...merged]);
  installed = true;
}
