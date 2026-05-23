# `services/observability/`

Cross-cutting observability primitives that the rest of the backend
plugs into. Owns nothing about business logic — only the **shape of
the signals** that ops, support, and engineering need to see.

| File | Purpose |
|---|---|
| `health-check.js` | Deep liveness / readiness / full health probes. Pure functions; caller injects `prisma` / `redis` / `queue` so tests run offline. Mounted by `backend/index.js` at `/health`, `/health/live`, `/health/ready`. |
| `otel.js` | Optional OpenTelemetry SDK bootstrap for distributed traces. Starts before Express/HTTP imports when `OTEL_ENABLED=true` or an OTLP endpoint is configured. |
| `spans.js` | OpenTelemetry-compatible span helpers (caller-side tracing). |

## OpenTelemetry runtime

Tracing is intentionally opt-in. The backend starts the SDK only when:

- `OTEL_ENABLED=true`, or
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

Required production exporter:

```bash
OTEL_ENABLED=true
OTEL_SERVICE_NAME=siragpt-backend
OTEL_TRACES_EXPORTER=otlp
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otel-collector.example.com/v1/traces
```

If only `OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318` is set, the
bootstrap derives `http://collector:4318/v1/traces`.

Behavior:

- HTTP/Express, Pino, ioredis, pg, undici and OpenAI calls are auto-instrumented.
- `/health*` and `/metrics` are ignored to keep traces focused on user work.
- Every traced request receives `X-Trace-Id` and keeps `X-Request-Id`.
- The active request span gets `siragpt.request_id` and `siragpt.authenticated`.
- No user prompts, file contents, auth tokens or raw tool payloads are attached.
- `/health` includes a non-critical `opentelemetry` check so ops can see whether tracing is `healthy`, `degraded` or `skipped`.

## Health-check contract

`runReadinessCheck({ prisma, redis, queue })` aggregates four checks
and produces:

```js
{
  status: "healthy" | "degraded" | "unhealthy",
  timestamp: <ISO 8601>,
  checks: [
    { name, status, critical, latency_ms, details?, error? },
    ...
  ],
}
```

Decision rule (`composeStatus`):
- **unhealthy** if any *critical* check is unhealthy.
- **degraded** if a non-critical check is degraded.
- **healthy** otherwise.

`reportToHttpStatus(report)` maps:
- healthy / degraded → HTTP 200.
- unhealthy → HTTP 503 (load balancer drains).
- malformed → HTTP 500.

## Critical vs non-critical

Critical checks fail closed. Non-critical checks are informational
and never produce a 503 on their own.

| Check | Critical |
|---|---|
| `database` | yes |
| `redis` | yes |
| `process` | yes |
| `queue` | no — a stalled BullMQ should not 503 the synchronous chat path |
| `model_providers` | no — purely env-config introspection |

## When to add a check

1. The dependency is hit on the request path (DB, queue, cache, etc.).
2. The dependency has a fast probe (≤ 1 round-trip).
3. The probe must not invoke a paid external service (no LLM pings).

If those three hold, add a `checkXxx(client)` function returning the
uniform shape, register it in `runReadinessCheck` (or
`runFullHealthCheck` for informational), and add a test in
`backend/tests/sira-health-and-metrics.test.js`.

## See also

- [`backend/src/services/sira/README.md`](../sira/README.md) — pipeline metrics.
- [`backend/src/services/agents/metrics.js`](../agents/metrics.js) — Prometheus registry.
- [`docs/architecture/PIPELINE.md`](../../../../docs/architecture/PIPELINE.md) §12 — observability stack.
