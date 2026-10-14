// Probe: will this Devin use the MCP servers a client such as Paseo hands it?
//
//   node devin-mcp-probe.mjs [--out probe-mcp.txt] [--cmd devin]
//
// Paseo gives every agent its own tools (message another agent, start one, ...) as an MCP server
// passed in `session/new`. This starts `devin acp`, passes it two throwaway MCP servers, one over
// HTTP and one over stdio, and reports which of them Devin actually connected to, what Devin says
// about each, and the MCP capabilities it announced. It tries three times in a row, because the
// same Devin has been seen to take the servers once and ignore them the next time; one "no" is not
// an answer. No model is called, so no ACU is used, and no login token is read or sent. The servers
// are local and offer a single tool each.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index > -1 && argv[index + 1] ? argv[index + 1] : fallback;
};
const command = value("cmd", "devin");
const outFile = value("out");
if (outFile) writeFileSync(outFile, "");
const say = (line) => {
  console.log(line);
  if (outFile) appendFileSync(outFile, `${line}\n`);
};

const dir = mkdtempSync(path.join(tmpdir(), "devin-mcp-probe-"));
const ATTEMPTS = 3;
const markerFor = (attempt) => path.join(dir, `stdio-marker-${attempt}.txt`);
// The stdio server, written to a file Devin can start: logs that it ran, answers the handshake.
const stdioServer = path.join(dir, "stdio-mcp.mjs");
writeFileSync(
  stdioServer,
  `import { appendFileSync } from "node:fs";
appendFileSync(process.env.MARKER, "started\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) > -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    appendFileSync(process.env.MARKER, "got " + message.method + "\\n");
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    if (message.method === "initialize") reply({ protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "probe-stdio", version: "1" } });
    else if (message.method === "tools/list") reply({ tools: [{ name: "ping_stdio", description: "ping", inputSchema: { type: "object", properties: {} } }] });
    else if (message.id !== undefined) reply({});
  }
});
`,
);

const httpLog = [];
const attemptOf = (url) => Number(new URL(url, "http://x").searchParams.get("attempt") ?? 0);
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    let message = {};
    try {
      message = JSON.parse(body);
    } catch {}
    httpLog.push({
      attempt: attemptOf(request.url),
      method: message.method ?? `${request.method} (no body)`,
    });
    response.setHeader("content-type", "application/json");
    if (message.method === "initialize") {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "probe-http", version: "1" },
          },
        }),
      );
    } else if (message.method === "tools/list") {
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "ping_http",
                description: "ping",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        }),
      );
    } else {
      response.statusCode = 202;
      response.end();
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const child = spawn(command, ["acp"], {
  stdio: ["pipe", "pipe", "ignore"],
  shell: process.platform === "win32",
});
child.on("error", (error) => {
  console.error(`could not start '${command} acp': ${error.message}`);
  process.exit(1);
});
let buffer = "";
let nextId = 1;
const pending = new Map();
const notes = [];
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) > -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && !message.method) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
        else waiter?.resolve(message.result);
      } else if (message.method === "_cognition.ai/output") {
        const text = JSON.stringify(message.params);
        if (/probe-/iu.test(text))
          notes.push(`${message.params.channel}: ${message.params.message}`.slice(0, 220));
      }
    } catch {}
  }
});
const send = (method, params, timeoutMs = 60_000) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(
      () => reject(new Error(`${method} got no answer in ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const results = [];
try {
  const init = await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
  say(
    `Devin announced MCP capabilities: ${JSON.stringify(init.agentCapabilities?.mcpCapabilities)}`,
  );
  say(`Devin: ${JSON.stringify(init.agentInfo)}`);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const marker = markerFor(attempt);
    writeFileSync(marker, "");
    const before = httpLog.length;
    const session = await send("session/new", {
      cwd: dir,
      mcpServers: [
        {
          type: "http",
          name: `probe-http-${attempt}`,
          url: `http://127.0.0.1:${port}/mcp?attempt=${attempt}`,
          headers: [],
        },
        {
          name: `probe-stdio-${attempt}`,
          command: process.execPath,
          args: [stdioServer],
          env: [{ name: "MARKER", value: marker }],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const httpUsed = httpLog.slice(before).filter((entry) => entry.attempt === attempt).length > 0;
    const stdio = existsSync(marker) && readFileSync(marker, "utf8").trim().length > 0;
    results.push({ attempt, accepted: Boolean(session.sessionId), http: httpUsed, stdio });
    say(
      `attempt ${attempt}: session accepted=${Boolean(session.sessionId)}  HTTP server contacted=${httpUsed ? "YES" : "NO"}  stdio server started=${stdio ? "YES" : "NO"}`,
    );
  }
} catch (error) {
  say(`failed: ${error.message.slice(0, 300)}`);
}

say(`What Devin said about the servers:${notes.length ? `\n  ${notes.join("\n  ")}` : " nothing"}`);
const httpWorked = results.filter((r) => r.http).length;
const stdioWorked = results.filter((r) => r.stdio).length;
say(
  `HTTP MCP server used in ${httpWorked} of ${results.length} attempts; stdio MCP server used in ${stdioWorked} of ${results.length}.`,
);
let verdict =
  "=> this Devin uses them only sometimes: Paseo's agent tools will be there in some sessions and missing in others.";
if (httpWorked + stdioWorked === 0) {
  verdict =
    "=> this Devin ignored the MCP servers a client passes in session/new (not supported in this version, or blocked by team policy): Paseo's own agent tools cannot reach it over ACP.";
} else if (httpWorked + stdioWorked === results.length * 2) {
  verdict = "=> this Devin uses the MCP servers a client passes in session/new.";
}
say(verdict);
child.kill();
server.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
