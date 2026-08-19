# Interactive API documentation (`/api-docs`)

Phase 8i wires `swagger-ui-express` on top of the existing OpenAPI
3.1 spec generator (`backend/src/services/contracts/schema-registry.js`)
to expose an interactive explorer at `/api-docs`.

## What you get

| Path                       | What                                           |
| -------------------------- | ---------------------------------------------- |
| `GET /api-docs/`           | Swagger UI rendered against the live spec      |
| `GET /api-docs/openapi.json` | Raw OpenAPI 3.1 JSON (no auth, env-gated)    |
| `GET /api/enterprise/contracts/openapi` | Same spec, **auth-gated** (preexisting; kept for clients that already use it) |

The Swagger UI surface includes:

- A try-it-out console that sends real requests against the running
  backend.
- A persistent JWT field (Authorization Bearer header) that survives
  page reloads via `localStorage`.
- Endpoints sorted alphabetically and grouped by tag for readability.

## Default exposure rules

| `NODE_ENV` | `API_DOCS_ENABLED` | Result          |
| ---------- | ------------------ | --------------- |
| any non-`production` | unset / empty | enabled (DX-friendly default) |
| `production` | unset / empty | **disabled** (404 with hint) |
| any | `true` / `1` / `yes` | enabled |
| any | `false` / `0` / `no` | disabled |

When disabled, the route still responds — with a small JSON 404 that
points operators at the env flag instead of Express's generic
"Cannot GET /api-docs" page:

```json
{ "error": "api-docs disabled", "hint": "set API_DOCS_ENABLED=true to expose interactive docs" }
```

## Why the env-gate (and not auth)

The OpenAPI spec itself never carries secrets — every example value is
a placeholder, every credential field is a documented input. But:

- The rendered explorer is a one-click attack surface for anyone who
  has a JWT (legitimate user + bored intern with API access).
- Some endpoints are intentionally not advertised (admin / superadmin
  routes), and the spec naturally includes them.

For production, the recommended posture is:

1. Set `API_DOCS_ENABLED=true` only on a staging or admin-only
   subdomain.
2. Use a reverse-proxy guard (basic-auth, VPN, IP allowlist, or
   Cloudflare Access) on `/api-docs` for the production domain if
   you want an internal-only renderer.
3. Or leave it disabled in production entirely and use the
   `GET /api/enterprise/contracts/openapi` endpoint (auth-gated)
   for tooling that needs the spec.

## Operator runbook

### Verifying the explorer in dev

```bash
# After `npm run dev` in /backend
curl -i http://localhost:5000/api-docs/openapi.json | head -20
# → HTTP/1.1 200 OK + JSON spec

open http://localhost:5000/api-docs/
# → Swagger UI page. Paste a JWT in "Authorize", try any endpoint.
```

### Enabling in production

```bash
# Set in your deploy environment
NODE_ENV=production
API_DOCS_ENABLED=true
API_DOCS_TITLE="My Company API"
# Restart the backend.
```

Pair with a reverse-proxy block:

```nginx
location /api-docs {
    auth_basic "siraGPT internal docs";
    auth_basic_user_file /etc/nginx/.htpasswd-docs;
    proxy_pass http://backend;
}
```

### Disabling on dev (quiet local boot)

```bash
API_DOCS_ENABLED=false npm run dev
```

## Non-goals (intentional)

- **No live spec mutation.** The spec is built per-request from
  `schema-registry.js`. Adding a route shows up immediately, but
  there is no way to *edit* the spec via the explorer — it's
  read-only by design.
- **No automated client generation.** Use the raw JSON at
  `/api-docs/openapi.json` with `openapi-generator-cli` or your
  language's preferred toolchain.
- **No replacement of `@asteasolutions/zod-to-openapi`.** That
  package was already evaluated by the team and skipped because it
  requires zod v4 while the backend is on zod v3. The custom
  generator in `schema-registry.js` is the source of truth.

## Tests

`backend/tests/api-docs.test.js` (10 cases):

- `resolveApiDocsConfig`: 7 env-resolution branches (prod default,
  dev default, override both ways, custom title, case-insensitive
  NODE_ENV).
- `buildApiDocsRouter` disabled mode: hits the route, asserts 404 +
  JSON hint shape.
- `buildApiDocsRouter` enabled mode: spins up an actual express
  server (no supertest dep), GETs `/api-docs/` and `/openapi.json`,
  asserts content-types and the Swagger UI HTML shell.
