# Rovo deepSearch over MCP (no client LLM)

A dependency-free Node script (Node 18+) that signs the user in with OAuth, sends a prompt to the Atlassian Rovo MCP server's `deepSearch` operation, and prints Rovo's synthesized, cited answer. The app contains no LLM; Rovo does the retrieval and synthesis server-side.

`deepSearch` needs an OAuth 3LO user token with the `search:rovo:agent-interface` scope. API tokens and service-account keys are not supported for it today.

## Run

```
export ATLASSIAN_SITE="your-site.atlassian.net"
node deepsearch.mjs "What is the Test Case Helper agent?"
node deepsearch.mjs --effort light "BCU FW 3.3 backlog"   # ranked sources only
node deepsearch.mjs --sources confluence,slack "..."       # restrict sources
node deepsearch.mjs --json "..."                           # raw JSON for your app to parse
node deepsearch.mjs                                        # interactive prompt loop
node deepsearch.mjs --logout                               # forget cached tokens
```

The first run opens the browser for sign-in and consent. Tokens are cached in `~/.rovo-deepsearch-demo.json` (mode 600) and refreshed automatically afterwards. The org admin may need to allow the MCP server for the site.

## Scopes

Read-only search: `search:rovo:agent-interface`, plus `read:me`, `read:account` and `offline_access` (for token refresh). `deepSearch` retrieves and summarizes; it never writes to Atlassian.

## How the sign-in works

1. Discovers the auth server from `https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp`.
2. Registers a public client once via Dynamic Client Registration, with redirect URI `http://127.0.0.1:8976/callback` (override the port with `OAUTH_CALLBACK_PORT`).
3. Runs authorization code + PKCE (S256) in the browser, with `resource=https://mcp.atlassian.com/v2/mcp`.
4. Calls MCP with `Authorization: Bearer <access_token>`.

## How the call works

1. `POST https://mcp.atlassian.com/v2/mcp` with `initialize` and `notifications/initialized` (JSON-RPC over Streamable HTTP; JSON and SSE replies are both handled).
2. `tools/call` -> `executeRead` with `{ name: "deepSearch", cloudId, inputs: { query, effort } }`.
3. Parses `data.answer` and `data.sources[]` (`title`, `url`).

## Notes

- Each prompt is independent. There is no conversation memory, so resend context for follow-ups.
- `deepSearch` may consume Rovo credits and is slower with `--effort agentic`.
- Token auth is not tied to one site, so the script always passes `cloudId` explicitly.
- For a production app, store tokens in the OS keychain rather than a file.
