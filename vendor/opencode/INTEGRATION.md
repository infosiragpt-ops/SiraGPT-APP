# OpenCode engine — vendored into siraGPT

This directory is the **OpenCode coding-agent engine**, vendored from
[`sst/opencode`](https://github.com/sst/opencode) (`packages/opencode`).
**License: MIT** (see `LICENSE`). Keep the upstream copyright notice.

We bring the *engine implementation* here (not the TUI/desktop/web/docs/infra
packages). The real agent lives under `src/`:

- `src/agent`, `src/tool`, `src/skill` — the agent loop, tools, skills
- `src/session`, `src/message` — conversations / message parts
- `src/server` — the HTTP server (`opencode serve`, OpenAPI at `/doc`)
- `src/provider`, `src/llm` — model providers
- `src/lsp`, `src/mcp`, `src/permission`, `src/plugin` — LSP, MCP, perms, plugins
- `src/index.ts` — entry point

## Runtime reality (important)

OpenCode runs on **Bun** (`bun@1.3.x`) and uses the **Effect** framework. It is
**not** a Node/Express module — it does **not** merge into siraGPT's Express
backend process. It runs as a **sidecar service**, and siraGPT's backend talks
to it over HTTP.

## Run it (sidecar)

```bash
cd vendor/opencode
bun install
bun run ./src/index.ts serve --port 4096 --hostname 127.0.0.1
# optional auth: OPENCODE_SERVER_PASSWORD=... bun run ./src/index.ts serve ...
```

`test/` (heavy image fixtures) was excluded when vendoring; restore from
upstream if you need to run OpenCode's own test suite.

## How siraGPT connects

siraGPT's Express backend drives this server via the thin client:

- `backend/src/services/opencode/opencode-config.js` — reads
  `OPENCODE_SERVER_URL` / `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`
- `backend/src/services/opencode/opencode-client.js` — sessions, prompt,
  file/find, SSE event stream URL

So the data flow is:

```
siraGPT /code UI  →  Express backend (opencode-client)  →  [ this engine: bun serve ]
                  ←  SSE proxy  ←  /event
```

## Status & next steps

1. ✅ Engine source vendored here (MIT).
2. ▢ `bun install` + `bun run serve` on the host (or a container).
3. ▢ Validate the client's endpoint paths against this server's `/doc`
   (OpenAPI) and adjust `ENDPOINTS` in `opencode-client.js` if needed.
4. ▢ Per-user sandbox/isolation for multi-tenant use (containers).
5. ▢ Route siraGPT's provider keys + credits into OpenCode's provider config.
6. ▢ Wire the siraGPT `/code` UI as the client (chat→prompt, events→SSE,
   files→tree/editor/preview).

Upstream: https://github.com/sst/opencode · https://opencode.ai/docs/
