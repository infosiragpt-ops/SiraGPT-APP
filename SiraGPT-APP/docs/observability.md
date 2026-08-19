# Observability

End-to-end runbook for the SiraGPT backend's tracing, logging, and
metrics stack. The goal is a single, coherent signal pipeline: every
log line, span, and counter shares the same `trace_id`, so an operator
can pivot from a noisy dashboard to the exact log line that fired the
alert without a context switch.

## Stack at a glance

| Concern    | Library                                | Surface                                    |
|------------|----------------------------------------|--------------------------------------------|
| Tracing    | `@opentelemetry/sdk-node` + auto-instr | OTLP/HTTP exporter                         |
| Logging    | `pino` + `pino-http`                   | stdout JSON, redacted at write time        |
| Metrics    | In-process Prometheus registry         | `/metrics`, `/internal/metrics`, `/api/se-agents/metrics`, `/api/free-ia/metrics.prom` |
| Errors     | Sentry (optional)                      | configured in `services/observability/sentry.js` |
| LLM cost   | Langfuse + custom recorder             | `services/observability/llm-cost.js`       |

The OTel SDK is initialised in `backend/src/services/observability/otel.js`
and started before the Express app is built, so all subsequent
`require()`s pick up the auto-instrumented modules (express, http, pg,
ioredis, undici, openai, pino).

## Tracing

### Configuration

Tracing is opt-in via env vars (no exporter endpoint → SDK stays off):

| Variable                              | Default                       | Purpose                                                   |
|---------------------------------------|-------------------------------|-----------------------------------------------------------|
| `OTEL_ENABLED`                        | inferred from endpoint        | Explicit on/off override.                                 |
| `OTEL_SDK_DISABLED`                   | `false`                       | Hard kill switch (matches the OTel spec).                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | —                             | Base URL for the OTLP/HTTP collector.                     |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`  | `…/v1/traces`                 | Override just the traces path if needed.                  |
| `OTEL_TRACES_EXPORTER`                | `otlp`                        | Set to `none` to disable export entirely.                 |
| `OTEL_SERVICE_NAME`                   | `siragpt-backend`             | Becomes the `service.name` resource attribute.            |
| `OTEL_SERVICE_NAMESPACE`              | `siragpt`                     | Resource attribute, used to group services.               |
| `OTEL_DEPLOYMENT_ENVIRONMENT`         | `NODE_ENV` or `development`   | Resource attribute.                                       |
| `OTEL_TRACES_SAMPLER`                 | `parentbased_always_on`       | See sampling section.                                     |
| `OTEL_TRACES_SAMPLER_ARG`             | `1`                           | Ratio for `traceidratio` / `parentbased_traceidratio`.    |
| `OTEL_FAIL_FAST`                      | `false`                       | When truthy, a startup failure crashes the process.       |

### Sampling

The sampler is resolved by `resolveSampler()` in `otel.js` and supports
the standard OTel kinds:

- `always_on` — every span
- `always_off` — drop every span (useful for staging cost control)
- `traceidratio` — sample by trace-id hash, ratio in `OTEL_TRACES_SAMPLER_ARG`
- `parentbased_always_on` (default) — respect upstream decision, sample roots
- `parentbased_always_off`
- `parentbased_traceidratio` — recommended for high-traffic prod

Recommended production setting:

```
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.05   # 5% of root spans
```

### What's instrumented

Auto-instrumentation is configured in `createInstrumentationConfig()`:

- `http`, `express`, `pg`, `ioredis`, `undici`, `openai` — on
- `pino` — on (auto-injects `trace_id`/`span_id` into log records)
- `fs`, `dns` — off (too noisy)

The four metrics aliases (`/metrics`, `/internal/metrics`,
`/api/se-agents/metrics`, and `/api/free-ia/metrics.prom`) plus
`/health/*` are excluded from incoming HTTP spans so scrape traffic
doesn't dilute the dataset.

### Manual spans

Use `services/observability/spans.js` for application-level spans
(orchestrator stages, expensive RAG calls). Anything inside an `await`
chain that descends from an Express handler is already part of the
request span; only add manual spans where the auto-instrumentation
can't see (e.g. queue jobs, scheduled workers).

### Trace context on responses

`middleware/otel-request-context.js` echoes the active `trace_id` back
on every response as `X-Trace-Id`. Frontend reports and incident tickets
should always include this header — it's the single key that joins logs,
traces, and Sentry events for that request.

## Structured logging

`backend/src/middleware/logger.js` builds the global `pino` logger plus
the `pino-http` access logger:

- Output is line-delimited JSON on stdout in every environment. Pipe
  through `pino-pretty` locally for readability.
- `LOG_LEVEL` (default `info`) controls verbosity.
- Sensitive paths (auth headers, cookies, common token/secret fields)
  are redacted at write time via `fast-redact` — see `REDACT_PATHS`.
- The mixin `traceCorrelationMixin()` injects `trace_id`, `span_id`, and
  `trace_flags` from the active OTel context into every record. When no
  span is active (e.g. during boot, in workers without an active trace),
  the fields are simply omitted.

Use `req.log.info({...}, 'message')` inside handlers — it's bound to
the request id so all log lines for one request share the same `req.id`
in addition to `trace_id`.

## Metrics

The backend exposes one protected Prometheus body on four equivalent paths:

- `GET /metrics` — canonical scrape path
- `GET /internal/metrics` — alias intended for ingress allow-listing
- `GET /api/se-agents/metrics` — compatibility alias
- `GET /api/free-ia/metrics.prom` — Free-IA compatibility alias

All four delegate to the same access policy and render one canonical
exposition composed from the utility, agent,
process, cognitive, and fallback registries by
`services/observability/metrics-exposition.js`. New operational families
should normally use `utils/metrics.js`; there is still exactly one scrape
body per process.

Free-IA request-level attempt/success/error counters are emitted only by the
request that wins creation of the durable, user-scoped
`credit_transactions` reservation. Replays and quota losers do not increment
them. The ledger commit deliberately precedes the in-memory counter; a process
crash in that narrow interval can under-count one attempt, while the durable
ledger remains authoritative for reconciliation. Provider-call metrics are
separate and may count individual rewrite passes.

Remote scrapers authenticate with `Authorization: Bearer $METRICS_TOKEN`.
A validated super-admin session is also accepted. Socket-loopback bypass is
development-only by default; production requires
`METRICS_ALLOW_LOOPBACK=true`, and forwarded requests never receive that
bypass.

### RED method (Rate / Errors / Duration) per endpoint

The `redMetricsMiddleware` (`middleware/red-metrics.js`) is mounted
right after the OTel context middleware in `backend/index.js`. It emits:

| Metric                          | Type      | Labels                                | Notes                                                  |
|---------------------------------|-----------|---------------------------------------|--------------------------------------------------------|
| `http_requests_total`           | counter   | `method`, `route`, `status_class`     | One per response, including aborted (`status_class=aborted`). |
| `http_request_errors_total`     | counter   | `method`, `route`, `status_class`     | Increments only on `5xx` or aborted client connections. |
| `http_request_duration_ms`      | histogram | `method`, `route`, `status_class`     | Buckets: 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000 ms. |

The `route` label is the **matched** Express route pattern
(`/api/users/:id`), never the raw URL — high-cardinality identifiers
in the path can't blow up the metric registry. Unmatched requests fall
back to `route="unmatched"`.

Example PromQL:

```promql
# p99 latency by route, last 5 minutes
histogram_quantile(0.99,
  sum by (le, route) (rate(http_request_duration_ms_bucket[5m])))

# error rate per route
sum by (route) (rate(http_request_errors_total[5m]))
  / sum by (route) (rate(http_requests_total[5m]))
```

### Domain metric families

Already registered against the same registry:

- `services/agents/metrics.js` — agent invocations, token usage, tool
  calls, durations, rate-limit reasons, injection signals.
- `services/sira/metrics.js` — chat-pipeline turns, stage durations,
  envelope validation, clarifications, token-budget decisions.

Register domain-specific counters here rather than spinning up new
registries — there should always be exactly one scrape endpoint.

## Joining the signals

A typical incident walkthrough:

1. Dashboard alert fires on `http_request_errors_total{route="/api/foo"}`.
2. Open the matching trace in Tempo/Jaeger using the `service.name` and
   time window.
3. Pull a representative `trace_id` from a span; grep logs for
   `trace_id=…` to get the full per-request log trail.
4. Correlate with Sentry events (which carry the same `trace_id` via
   the SDK integration in `services/observability/sentry.js`).

## Local development

The SDK stays off by default — without `OTEL_EXPORTER_OTLP_ENDPOINT`
set, `startOpenTelemetry()` is a no-op. To run a local collector:

```bash
docker run --rm -p 4318:4318 otel/opentelemetry-collector:latest
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_TRACES_SAMPLER=always_on \
npm run dev
```

For metrics, hit `curl localhost:3001/internal/metrics`. For logs,
`npm run dev | pino-pretty`.

## Tests

| File                                              | Covers                                       |
|---------------------------------------------------|----------------------------------------------|
| `backend/tests/otel-observability.test.js`        | OTel config resolution, status reporting     |
| `backend/tests/otel-sampler.test.js`              | Sampler env-var parsing + clamping           |
| `backend/tests/logger-redaction.test.js`          | `fast-redact` paths catch known token shapes |
| `backend/tests/logger-trace-correlation.test.js`  | `traceCorrelationMixin` injects span context |
| `backend/tests/structured-logger.test.js`         | Domain `StructuredLogger` helpers            |
| `backend/tests/red-metrics.test.js`               | RED middleware: counters, histogram, aborts  |
| `backend/tests/sira-health-and-metrics.test.js`   | Sira pipeline metric families end-to-end     |
| `backend/tests/sentry-observability.test.js`      | Sentry init + capture wiring                 |
| `backend/tests/metrics-registry.test.js`          | `utils/metrics.js` counter/gauge/histogram + helpers |
| `backend/tests/prometheus-rules-contract.test.js` | Unified inventory, ratio semantics, queue alerts, optional `promtool` fixture |
| `backend/tests/request-logger.test.js`            | Structured request logger middleware         |

## Health + Prometheus endpoints

The backend now ships three top-level observability endpoints:

| Endpoint                          | Auth                              | Purpose                                                                 |
|-----------------------------------|-----------------------------------|-------------------------------------------------------------------------|
| `GET /api/admin/analyzer/health`  | admin token                       | Snapshot of the document analyzer pipeline (open breakers, degraded analyzers, in-process cache hit/miss stats, config) — see `services/document-professional-analyzer.js#getAnalyzerHealthSnapshot`. |
| `GET /api/admin/health/services`  | super-admin token                 | Liveness probe of external dependencies (Postgres, Redis, Stripe, SMTP, AI providers). Each probe is bounded at 2 s so one dead dependency does not mask the rest. |
| `GET /metrics` (plus three aliases above) | `METRICS_TOKEN`, validated super-admin session, or explicitly enabled direct loopback | Unified Prometheus text-exposition exporter owned by `services/observability/metrics-exposition.js`. |

### `/metrics` series

| Family                                         | Type      | Labels                  | Source                                  |
|------------------------------------------------|-----------|-------------------------|-----------------------------------------|
| `siragpt_http_requests_total`                  | counter   | method, route, status, request_class | HTTP middleware in `index.js` |
| `siragpt_http_request_duration_seconds_*`      | histogram | method, route, request_class + le | HTTP middleware in `index.js` |
| `siragpt_http_slo_requests_total`              | counter   | request_class, status_class | Low-cardinality HTTP SLO path in `index.js` |
| `siragpt_http_slo_request_duration_seconds_*`  | histogram | request_class + le      | Low-cardinality HTTP SLO path in `index.js` |
| `siragpt_circuit_breaker_state`                | gauge     | name                    | `utils/circuit-breaker.js` → `metrics.trackCircuitBreaker` (0=closed, 1=half_open, 2=open) |
| `agent_task_terminal_total`                    | counter   | status                  | Best-effort in-process terminal observation (`success`, `error`, `cancelled`) |
| `siragpt_queue_jobs`                           | gauge     | queue, state            | Shared bounded queue health probe       |
| `siragpt_queue_probe_up`                       | gauge     | queue                   | Shared queue probe (1=ready, 0=failed)  |
| `siragpt_queue_probe_status`                   | gauge     | status                  | Aggregate probe status                  |
| `siragpt_queue_probe_last_success_timestamp_seconds` | gauge | queue              | Last successful queue observation       |
| `siragpt_queue_probe_staleness_seconds`        | gauge     | queue                   | Age of the last successful observation  |
| `siragpt_async_guards_active`                  | gauge     | —                       | `utils/async-guard.js` register/settle  |
| `siragpt_analyzer_cache_hits_total`            | counter   | —                       | Delta-sampled from analyzer health snapshot on each `/metrics` scrape |
| `siragpt_analyzer_cache_misses_total`          | counter   | —                       | Same                                    |
| `siragpt_process_uptime_seconds`               | gauge     | —                       | `process.uptime()`                      |
| `siragpt_nodejs_memory_bytes`                  | gauge     | type=rss/heapUsed/heapTotal/external | `process.memoryUsage()`        |

Additional lifecycle and framework series (`agent_task_invocations_total`,
`se_agent_*`) keep flowing through `services/agents/metrics.js` and
remain exposed in the same canonical body. The invocation counter is
diagnostic lifecycle telemetry; SLO rules use
`agent_task_terminal_total`.

The terminal counter uses a local snapshot marker to deduplicate event-first
and status-first writes in one task store. It is not durable/CAS telemetry:
a crash can lose an increment and concurrent replicas can race. Summing
`rate()` across replicas assumes one execution owner per task; asymmetric
duplicates or misses bias the success ratio. U0 must add a transactional
outbox before this family becomes an authoritative completion ledger.

`request_class` is deliberately bounded to `standard`, `streaming`, and
`health`. Health-path matching takes precedence; otherwise an
SSE `Content-Type: text/event-stream` response is `streaming`, and the
remaining responses are `standard`. HTTP SLO rules select only
`request_class="standard"` from the dedicated `siragpt_http_slo_*`
families. Their only other dimension, `status_class`, is bounded to
`1xx`, `2xx`, `3xx`, `4xx`, `5xx`, or `other`. Normal traffic can
therefore create at most 18 SLO counter series and three SLO histogram
series. Every request records both the detailed and SLO families.

Detailed request and duration families retain route-level diagnostics.
When either reaches `maxSeries`, all labels fold into one global
`__other__` series using an O(1) lookup; no preserved-label tuple can
create extra overflow series. SLO computations remain complete because
they are isolated from detailed-family overflow.

Queue metrics refresh on server startup and every 30 seconds, then stop
during the scheduler shutdown phase. The interval is configurable with
`HEALTH_QUEUE_METRICS_REFRESH_INTERVAL_MS` (bounded to 1–300 seconds).
Backlog alerts filter each instance's sample through
`probe_up == 1` and `staleness_seconds <= 120` before aggregating by queue.

### Sample Grafana / PromQL queries

```promql
# Request rate per route (5-minute window)
sum by (route) (rate(siragpt_http_requests_total{request_class="standard"}[5m]))

# SLO error fraction (5xx, all standard business requests)
sum(rate(siragpt_http_slo_requests_total{status_class="5xx",request_class="standard"}[5m]))
  / sum(rate(siragpt_http_slo_requests_total{request_class="standard"}[5m]))

# SLO p95 latency (all standard business requests)
histogram_quantile(0.95,
  sum by (le) (rate(siragpt_http_slo_request_duration_seconds_bucket{request_class="standard"}[5m])))

# Diagnostic p95 latency per route (best effort after detailed-series overflow)
histogram_quantile(0.95,
  sum by (route, le) (rate(siragpt_http_request_duration_seconds_bucket{request_class="standard"}[5m])))

# Currently-open circuit breakers
siragpt_circuit_breaker_state == 2

# Waiting BullMQ jobs without multiplying replica observations
max by (queue) (siragpt_queue_jobs{state="waiting"})

# Queue observation age by physical queue
max by (queue) (siragpt_queue_probe_staleness_seconds)

# Analyzer cache hit ratio
rate(siragpt_analyzer_cache_hits_total[5m])
  / (rate(siragpt_analyzer_cache_hits_total[5m]) + rate(siragpt_analyzer_cache_misses_total[5m]))

# Heap utilisation
siragpt_nodejs_memory_bytes{type="heapUsed"}
  / siragpt_nodejs_memory_bytes{type="heapTotal"}
```

## Request logger

`backend/src/middleware/request-logger.js` is wired in `index.js`
BEFORE `express.json()` so even malformed-body responses are logged. It
emits one JSON line per response:

```json
{"ts":"2026-05-19T12:00:00Z","level":"info","method":"GET","path":"/api/x","status":200,"durMs":12,"userId":"abc","reqId":"uuid","ip":"1.2.3.4","ua":"Mozilla/..."}
```

If `req.id` is unset upstream (e.g. before pino-http), the middleware
mints one via `crypto.randomUUID()` so every log line is correlatable.
