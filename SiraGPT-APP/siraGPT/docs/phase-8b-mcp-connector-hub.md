# Phase 8B: MCP Connector Hub

Date: 2026-05-01

## Scope

Phase 8B adds the first internal Model Context Protocol connector hub for SiraGPT.

Dependency:

- `@modelcontextprotocol/sdk@1.29.0`

This phase deliberately exposes an internal, authenticated, read-only registry only. It does not allow arbitrary remote MCP servers, browser-provided connector tokens, write tools or unauthenticated discovery.

## Tools

The initial approved tools are:

- `github.codex.status`
- `github.codex.repository_context`
- `rag.retrieve`
- `project.memory.list`
- `document.preview`

All tool manifests are validated against the MCP SDK schemas before being returned by the backend.

## API

All routes require the existing SiraGPT JWT session.

```http
GET /api/enterprise/mcp/status
```

Returns MCP hub version, SDK package metadata, safety posture and visible tools.

```http
GET /api/enterprise/mcp/tools
```

Returns only approved tool manifests visible under the server-side allowlist.

```http
POST /api/enterprise/mcp/tools/:name/call
Content-Type: application/json

{
  "arguments": {}
}
```

Invokes a single approved read-only tool and returns an MCP-compatible tool result.

## Security Model

- Authentication is mandatory through `authenticateToken`.
- Tenant scope is derived server-side from the authenticated user.
- Tool visibility and invocation are gated by `MCP_CONNECTOR_ALLOWLIST`.
- Browser-provided secrets are rejected before invocation.
- GitHub tokens still come only from backend environment variables.
- Project memory and document preview validate project ownership before reading data.
- Phase 8B does not connect to arbitrary user-supplied MCP servers.

Optional backend allowlist:

```env
MCP_CONNECTOR_ALLOWLIST="github.codex.status,github.codex.repository_context,rag.retrieve,project.memory.list,document.preview"
```

If unset, the backend defaults to the same read-only approved list.

## Verification

```bash
cd backend
node --test tests/mcp-tool-registry.test.js tests/sira-production-wiring.test.js
npm audit --omit=dev --audit-level=critical
cd ..
npm run licenses:check
git diff --check
```

Full release validation:

```bash
npm run lint -- --max-warnings 97
npx tsc --noEmit --skipLibCheck --ignoreDeprecations 5.0
npm run build
```

## Production Note

`https://siragpt.com/codex` was checked after Phase 8A and returned `404` while local `/codex` and CI were green. The repository currently has CI only, not a deployment workflow, so production appears to be serving an older Next.js build. Redeploying the VPS/hosted frontend remains an operational follow-up outside this code change.
