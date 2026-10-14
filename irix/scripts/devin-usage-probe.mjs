// Probe: what does Devin's own quota call return for this login?
// Usage: node irix/scripts/devin-usage-probe.mjs [--raw]
//
// Reads the Devin CLI login from credentials.toml and makes ONE request to the server named in
// it (refused unless the host is on the allowlist below). The key is never printed. The default
// output keeps only numbers and field names; --raw prints the full response with strings
// (emails, ids) masked, so check it before sharing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const ALLOWED_HOSTS = new Set(["api.devin.ai", "server.codeium.com"]);
const raw = process.argv.includes("--raw");

function credentialsPath() {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "devin",
      "credentials.toml",
    );
  }
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "devin", "credentials.toml");
}

// Only reads `key = "value"` lines; that is all this file needs.
function readValue(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, "m"));
  return match ? match[1] : undefined;
}

function cliVersion() {
  try {
    const out = execFileSync("devin", ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 15000,
    });
    return out.match(/\d+\.\d+\.\d+/)?.[0];
  } catch {
    return undefined;
  }
}

// Keeps structure and numbers, hides text such as emails, names and ids.
function mask(value) {
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]));
  }
  if (typeof value === "string") return /^-?\d+$/.test(value) ? value : `<string:${value.length}>`;
  return value;
}

const file = credentialsPath();
let text;
try {
  text = readFileSync(file, "utf8");
} catch (error) {
  console.error(`cannot read ${file}: ${error.message}`);
  process.exit(1);
}
const apiKey = readValue(text, "windsurf_api_key");
const server = readValue(text, "api_server_url");
if (!apiKey || !server) {
  console.error(`credentials.toml has no ${apiKey ? "api_server_url" : "windsurf_api_key"}`);
  process.exit(1);
}
const url = new URL(server);
if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
  console.error(`refusing to send the key to ${url.hostname}; not on the allowlist`);
  process.exit(1);
}

const version = cliVersion() ?? "0.0.0";
console.log(`server: ${url.hostname}  devin version: ${version}`);
const response = await fetch(
  `${url.origin}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
  {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify({
      metadata: {
        apiKey,
        ideName: "devin",
        ideVersion: version,
        extensionVersion: version,
        locale: "en",
      },
    }),
  },
);
const body = await response.text();
console.log(`status: ${response.status}`);
let json;
try {
  json = JSON.parse(body);
} catch {
  console.log(`not JSON (${body.length} bytes): ${body.slice(0, 200).replace(apiKey, "<key>")}`);
  process.exit(0);
}
console.log(JSON.stringify(raw ? mask(json) : numbersOnly(json), null, 2));

function numbersOnly(value, path = "") {
  const out = {};
  const walk = (node, at) => {
    if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${at}[${i}]`));
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, at ? `${at}.${k}` : k);
    } else if (
      typeof node === "number" ||
      typeof node === "boolean" ||
      /^-?\d+$/.test(String(node))
    ) {
      out[at] = node;
    } else if (/(^|\.)planName$/.test(at)) {
      out[at] = node;
    } else {
      out[at] = `<string:${String(node).length}>`;
    }
  };
  walk(value, path);
  return out;
}
