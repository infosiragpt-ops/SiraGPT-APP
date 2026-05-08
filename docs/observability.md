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
| Metrics    | In-process Prometheus registry         | `/metrics` and `/internal/metrics` (alias) |
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

The `/metrics`, `/internal/metrics`, and `/health/*` paths are excluded
from incoming HTTP spans so scrape traffic doesn't dilute the dataset.

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

The backend exposes Prometheus text format on two equivalent paths:

- `GET /metrics` — public scrape path
- `GET /internal/metrics` — alias intended for ingress allow-listing

Both render from a single in-process registry
(`services/agents/metrics.js`). New metric families are registered via
`registerCounter` / `registerHistogram` / `registerGauge`. Reusing the
shared registry means there's exactly one scrape endpoint per process.

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
