# /code workspace bootstrap (P0)

Short contract for the `/code` load path on https://siragpt.com/code.
This is the P0 that stops every failure collapsing into
«No se pudo cargar el espacio de código». It does **not** introduce
Temporal, Kubernetes runtimes, or a second workspace store.

## What ships in P0

1. **Structured errors** — `WorkspaceErrorCode` + payload
   `{ code, retryable, stage, severity, traceId, userMessage, internalMessage }`.
   The UI never renders a raw unknown as the only copy.
2. **`POST /api/code/workspaces/ensure`** — idempotent (required
   `Idempotency-Key`). Reuses the existing session + host-runner
   inspection. Retry never calls `startRun` again.
3. **Frontend state machine** on `/code`:
   `RESOLVING_SESSION → REQUESTING_WORKSPACE → PROVISIONING / MOUNTING / STARTING / CHECKING_HEALTH / CONNECTING → READY`,
   plus `RECONNECTING` and `DEGRADED`.
4. **Auto-recovery** — exponential backoff + jitter, same idempotency
   key, max 8 attempts. 401 refreshes `/api/auth/me` once. 409 /
   `ChunkLoadError` does one full reload guarded by `sessionStorage`.
5. **Progress, not a scare modal** while the request is expected to be
   pending. The generic modal appears only after recovery is exhausted,
   with `traceId` and Reintentar / Ir a /code / Volver al chat.
6. **`app/code/error.tsx`** — reports `buildId` + digest. ChunkLoad /
   version-skew uses the shared `lib/client-bundle-recovery.ts` helper
   (same sessionStorage guard as root `app/error.tsx`). Other crashes
   get one `reset()` after 750 ms keyed by digest. First paint is
   «Reconectando tu espacio…»; the generic modal appears only after
   that recovery is exhausted.
7. **Version skew** — `NEXT_PUBLIC_BUILD_ID` / `GIT_COMMIT` exposed as
   the client build id, sent as `X-Client-Build`. Next.js
   `generateBuildId` + `deploymentId` when those env vars are set.

## HTTP contract

| Status | Meaning |
|---|---|
| 200 | `READY` — logical workspace resolved (and runtime healthy if one was passed) |
| 202 | Pending (`retryAfterMs`, `progress`, `stage`) — keep the same key |
| 401 | `SESSION_REFRESH_REQUIRED` |
| 409 | `CLIENT_BUILD_MISMATCH` |
| 422 | Non-retryable (`INVALID_REQUEST`, mount/start failed) |
| 503 | Retryable (`TRANSIENT_UNAVAILABLE`, `CAPACITY_FULL`, health failed) |

Headers: `Idempotency-Key` (required), `X-Client-Build` (optional),
`X-Request-Id` (trace).

## Cache-Control guidance

- `/code` HTML: `private, no-cache, must-revalidate` (set in
  `next.config.mjs`). After a FE deploy, the document must not stay
  pinned to a previous HTML that points at deleted chunks.
- `/_next/static/*`: keep the default long-cache immutable policy.
  `generateBuildId` / `deploymentId` change the chunk URLs, so stale
  tabs recover via one reload instead of a cache wipe.
- `/api/code/workspaces/ensure`: `no-store`.
- CDN / reverse proxy: do not cache `/code` or `/api/code/*` by URL
  alone. If you cache HTML, key it by deployment id and purge on
  publish.

## Observability

Bootstrap failures log
`{ msg: code_workspace_bootstrap_failure, stage, code, traceId }`.
If `services/agents/metrics` is loaded, counters
`siragpt_code_workspace_ensure_total` and
`siragpt_code_workspace_bootstrap_failures_total` increment.

## Files

| Path | Role |
|---|---|
| `backend/src/services/code/workspace-errors.js` | Codes + classification |
| `backend/src/services/code/workspace-ensure.js` | Idempotent ensure |
| `backend/src/routes/code-workspaces.js` | HTTP surface |
| `lib/code-workspace-errors.ts` | Client classification |
| `lib/code-workspace-bootstrap.ts` | State machine + backoff |
| `lib/client-bundle-recovery.ts` | Shared ChunkLoad / stale-bundle hard-reload |
| `lib/code-workspace-error-boundary.ts` | Single auto-reset / skew reload |
| `components/code/code-workspace-bootstrap.tsx` | Progress + exhausted modal |
| `app/code/error.tsx` | Route error boundary (reconnect, then exhausted modal) |
| `app/error.tsx` | Root boundary now uses the shared helper |
| `app/code/page.tsx` | Wires the controller after the auth gate |

## What we did not invent

- No parallel workspace table. Logical id is
  `code:<userId>:<kind>:<ref>` derived from the existing folder /
  local / default identity.
- No new runner. `ensure` only **inspects** `host-runner.getStatus`.
  Preview start stays on `POST /api/code-runner/start`.
- Cowork `ensureWorkspaceForChat` and Codex project provision are
  unchanged. FEATURE_SDIE_V2, FEATURE_DOC_ENGINE, and agent-computer
  mounts are not touched.
- DeepSeek remains the only LLM this path would use; P0 makes no LLM
  calls.

## P1 roadmap (logical workspace vs runtime)

P0 treats “workspace” as a **logical** object (user + folder + local
files + optional existing runtime). P1 should split:

1. **Logical workspace** — durable id, file index, chat session bind,
   independent of whether a VM is up.
2. **Runtime** — host-runner / ACS computer / future K8s or Temporal
   worker, referenced by `runtimeId`, created once per logical
   workspace, reattached on Retry.
3. **Lease + health** — 202 stays the pending contract; a watcher
   (not the browser) advances PROVISIONING → READY.
4. **ACS computer** — if/when the agent-computer microservice is the
   runtime, `ensure` should attach to that session id instead of
   minting a second box.

Do not start (1)–(4) in this PR.
