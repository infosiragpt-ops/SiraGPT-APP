# Phase 8C: Tool Contracts and OpenAPI

Date: 2026-05-01

## Scope

Phase 8C adds a first contract registry for high-value SiraGPT routes and internal tools.

Dependency:

- `zod-to-json-schema@3.25.2`

`@asteasolutions/zod-to-openapi@8.5.0` was evaluated but not installed in this phase because it requires `zod@^4`. The backend currently standardizes on Zod 3 and several AI/runtime dependencies dedupe through that version, so forcing the peer or upgrading Zod would be a broader migration. OpenAPI is generated internally from the same exported JSON Schemas.

## Contract Surfaces

New authenticated Enterprise exports:

```http
GET /api/enterprise/contracts/json-schema
GET /api/enterprise/contracts/openapi
```

The registry covers:

- `/api/codex/github/status`
- `/api/codex/github/repo`
- `/api/codex/github/files`
- `/api/codex/github/ingest`
- `/api/codex/github/retrieve`
- `/api/agent/task`
- `/api/files/upload`
- `/api/rag/ingest`
- `/api/rag/retrieve`
- `/api/rag/ingest-code`
- `/api/rag/stats`

It also exports the MCP tool contracts used by:

- `github.codex.status`
- `github.codex.repository_context`
- `rag.retrieve`
- `project.memory.list`
- `document.preview`

## Drift Controls

- MCP tool manifests now use the contract registry as their input/output schema source.
- Tests compare MCP manifests against exported JSON Schemas.
- Tests verify key route bounds match the existing Express validators.
- OpenAPI inventory is tested against the JSON Schema route registry.

## Verification

```bash
cd backend
node --test tests/tool-schema-export.test.js tests/openapi-contracts.test.js tests/mcp-tool-registry.test.js
```

Full release validation remains:

```bash
npm run lint -- --max-warnings 97
npx tsc --noEmit --skipLibCheck --ignoreDeprecations 5.0
npm run build
npm run licenses:check
```

## Production Note

Production `/codex` remained blocked before this phase because `https://siragpt.com/codex` still returned `404` while local `/codex` and CI were green. No deploy workflow, Vercel project metadata or host runbook was available in the workspace, so production redeploy remains an operational step outside this code change.
