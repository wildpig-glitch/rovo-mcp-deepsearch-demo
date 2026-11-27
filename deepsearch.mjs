#!/usr/bin/env node
// Minimal Atlassian Rovo MCP client: signs in with OAuth 2.1 (browser + PKCE), sends a prompt to
// the `deepSearch` operation and prints the synthesized answer with its sources.
// No LLM runs on the client. deepSearch needs an OAuth user token with the
// `search:rovo:agent-interface` scope; API tokens are not supported for it.
//
// Site: ATLASSIAN_SITE (e.g. your-site.atlassian.net), or pass --site.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import readline from "node:readline/promises";

const MCP_URL = process.env.ATLASSIAN_MCP_URL ?? "https://mcp.atlassian.com/v2/mcp";
const AUTH_SERVER = "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3";
const PROTOCOL_VERSION = "2025-03-26";
const PORT = Number(process.env.OAUTH_CALLBACK_PORT ?? 8976);
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = "search:rovo:agent-interface read:me read:account offline_access";
const STORE = path.join(os.homedir(), ".rovo-deepsearch-demo.json");

function parseArgs(argv) {
  const opts = { effort: "agentic", json: false, prompt: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--site") opts.site = argv[++i];
    else if (a === "--effort") opts.effort = argv[++i];
    else if (a === "--sources") opts.sources = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--json") opts.json = true;
    else if (a === "--logout") opts.logout = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else opts.prompt.push(a);
  }
  opts.prompt = opts.prompt.join(" ").trim();
  return opts;
}

const b64url = (buf) => buf.toString("base64url");
const loadStore = () => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; } };
const saveStore = (d) => fs.writeFileSync(STORE, JSON.stringify(d, null, 2), { mode: 0o600 });

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${body.error_description ?? body.error ?? "request failed"}`);
  return body;
}

async function ensureClient(store) {
  if (store.client?.redirect === REDIRECT_URI) return store.client.id;
  const meta = await (await fetch(`${AUTH_SERVER}/.well-known/oauth-authorization-server`)).json();
  const res = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Rovo deepSearch demo",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) throw new Error(`Client registration failed (${res.status}): ${JSON.stringify(body)}`);
  store.client = { id: body.client_id, redirect: REDIRECT_URI };
  saveStore(store);
  return body.client_id;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd, args, () => {});
}

async function interactiveLogin(clientId) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const meta = await (await fetch(`${AUTH_SERVER}/.well-known/oauth-authorization-server`)).json();

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const err = u.searchParams.get("error");
      const ok = !err && u.searchParams.get("state") === state && u.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        ok ? "<h3>Signed in. You can close this tab.</h3>" : `<h3>Sign-in failed: ${err ?? "invalid state"}</h3>`);
      server.close();
      ok ? resolve(u.searchParams.get("code")) : reject(new Error(`Authorization failed: ${err ?? "state mismatch"}`));
    });
    server.listen(PORT, "127.0.0.1", () => {
      const url = new URL(meta.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: REDIRECT_URI, scope: SCOPES,
        state, code_challenge: challenge, code_challenge_method: "S256", resource: MCP_URL, prompt: "consent",
      }).toString();
      console.error(`Opening browser to sign in. If nothing opens, visit:\n${url}\n`);
      openBrowser(url.toString());
    });
    server.on("error", reject);
    setTimeout(() => { server.close(); reject(new Error("Timed out waiting for sign-in.")); }, 300000).unref();
  });

  return postForm(meta.token_endpoint, {
    grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId,
    code_verifier: verifier, resource: MCP_URL,
  });
}

// Returns a valid access token: cached, refreshed, or via a fresh browser login.
async function getAccessToken() {
  const store = loadStore();
  const t = store.token;
  if (t && t.expires_at > Date.now() + 60000) return t.access_token;
  const clientId = await ensureClient(store);
  let tok;
  if (t?.refresh_token) {
    try {
      tok = await postForm(`https://auth.atlassian.com/oauth/token`, {
        grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId,
      });
      tok.refresh_token ??= t.refresh_token;
    } catch { /* fall through to interactive login */ }
  }
  tok ??= await interactiveLogin(clientId);
  store.token = { ...tok, expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000 };
  saveStore(store);
  return tok.access_token;
}

class McpClient {
  #id = 0;
  #session;
  constructor(url, accessToken) {
    this.url = url;
    this.auth = `Bearer ${accessToken}`;
  }

  async #post(body) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: this.auth,
        ...(this.#session && { "Mcp-Session-Id": this.#session }),
      },
      body: JSON.stringify(body),
    });
    this.#session = res.headers.get("mcp-session-id") ?? this.#session;
    if (!res.ok) {
      const text = await res.text();
      const hint = res.status === 401 || res.status === 403
        ? " (sign-in expired or scope missing; run with --logout and retry)"
        : "";
      throw new Error(`MCP HTTP ${res.status}${hint}: ${text.slice(0, 500)}`);
    }
    return res;
  }

  // Responses are either plain JSON or an SSE stream containing the JSON-RPC reply.
  async #readReply(res, id) {
    const text = await res.text();
    if (!text) return undefined;
    const type = res.headers.get("content-type") ?? "";
    const messages = type.includes("text/event-stream")
      ? text
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => JSON.parse(l.slice(5).trim()))
      : [JSON.parse(text)];
    const reply = messages.find((m) => m.id === id);
    if (!reply) throw new Error("No JSON-RPC reply received.");
    if (reply.error) throw new Error(`MCP error ${reply.error.code}: ${reply.error.message}`);
    return reply.result;
  }

  async request(method, params) {
    const id = ++this.#id;
    const res = await this.#post({ jsonrpc: "2.0", id, method, params });
    return this.#readReply(res, id);
  }

  async notify(method, params) {
    await this.#post({ jsonrpc: "2.0", method, params });
  }

  async connect() {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "rovo-deepsearch-demo", version: "1.0.0" },
    });
    await this.notify("notifications/initialized");
  }

  callTool(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }
}

async function deepSearch(client, { site, prompt, effort, sources }) {
  const inputs = { query: prompt, effort, ...(sources && { sources }) };
  const result = await client.callTool("executeRead", { name: "deepSearch", cloudId: site, inputs });
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (result?.isError) throw new Error(text || "deepSearch failed");
  const parsed = JSON.parse(text);
  return parsed.data ?? parsed;
}

function render({ answer, sources = [] }) {
  console.log(`\n${answer?.trim() || "(no synthesized answer; use --effort agentic)"}\n`);
  if (sources.length) {
    console.log("Sources:");
    sources.forEach((s, i) => console.log(`  ${i + 1}. ${s.title}\n     ${s.url}`));
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: node deepsearch.mjs [--site <site>] [--effort light|agentic] [--sources a,b] [--json] [--logout] ["prompt"]
Without a prompt, starts an interactive loop (each prompt is independent: no chat memory).`);
    return;
  }
  if (opts.logout) {
    fs.rmSync(STORE, { force: true });
    console.log("Signed out (cached tokens removed).");
    return;
  }
  const site = opts.site ?? process.env.ATLASSIAN_SITE;
  if (!site) throw new Error("Set ATLASSIAN_SITE (e.g. your-site.atlassian.net) or pass --site.");

  const client = new McpClient(MCP_URL, await getAccessToken());
  await client.connect();

  const run = async (prompt) => {
    const data = await deepSearch(client, { site, prompt, effort: opts.effort, sources: opts.sources });
    if (opts.json) console.log(JSON.stringify(data, null, 2));
    else render(data);
  };

  if (opts.prompt) return run(opts.prompt);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Connected to ${MCP_URL}. Ask a question (empty line to quit).`);
  for (;;) {
    const prompt = (await rl.question("\n> ")).trim();
    if (!prompt) break;
    try {
      await run(prompt);
    } catch (e) {
      console.error(`Error: ${e.message}`);
    }
  }
  rl.close();
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
