# SiraGPT — Service Level Objectives (SLOs)

This document defines the SLIs/SLOs that govern the SiraGPT backend's
reliability budget and the alerting thresholds derived from them.
Prometheus rules implementing the burn-rate alerts live alongside this
file in [`prometheus-rules.yml`](./prometheus-rules.yml).

## Scope

The SLOs cover the public Express HTTP surface and the agentic task
runner. They do **not** cover background batch jobs, ingestion sweeps,
or one-off CLI utilities — those have their own job-level success
criteria.

| Service                     | Identifier                | Owner          |
|-----------------------------|---------------------------|----------------|
| HTTP API (Express)          | `siragpt-backend`         | Platform       |
| Agentic task runner         | `siragpt-agent`           | Agents team    |
| Document pipeline           | `siragpt-docs`            | Docs team      |
| LLM gateway / cache         | `siragpt-llm`             | Platform       |

## SLI catalogue

Service level *indicators* are computed from the in-process Prometheus
registry exposed at `/metrics` (see `docs/observability.md`).

### 1. HTTP availability

> Fraction of standard (non-streaming, non-health) HTTP responses that
> are not 5xx. Scrape paths are excluded before recording.

```
sli_http_availability =
  (
    1 - (
      (sum(rate(siragpt_http_slo_requests_total{status_class="5xx",request_class="standard"}[5m]))
        or vector(0))
      /
      clamp_min(
        sum(rate(siragpt_http_slo_requests_total{request_class="standard"}[5m])),
        0.000000001
      )
    )
  )
  and on() (
    sum(rate(siragpt_http_slo_requests_total{request_class="standard"}[5m])) > 0
  )
```

The zero-fill makes a healthy window with no 5xx series evaluate to
`1`; the positive-traffic gate makes an idle or missing window emit no
ratio at all, so it cannot create a false burn.

### 2. HTTP latency (p99)

> p99 of server-side request duration for standard requests in the
> unified HTTP exporter. `request_class` is bounded to `standard`,
> `streaming`, or `health`; only `standard` enters the SLO. Scrape
> endpoints are excluded by the middleware.

```
sli_http_latency_p99 =
  histogram_quantile(
    0.99,
    sum by (le) (
      rate(siragpt_http_slo_request_duration_seconds_bucket{request_class="standard"}[5m])
    )
  )
```

The histogram includes exact `1.5` second (SLO) and `3` second
(diagnostic alert) buckets.

### 3. Agent task success

> Fraction of observed agent task terminal outcomes that are `success`
> (excluding tasks cancelled by the caller).

```
sli_agent_success =
  (
    (sum(rate(agent_task_terminal_total{status="success"}[5m])) or vector(0))
    /
    clamp_min(
      sum(rate(agent_task_terminal_total{status=~"success|error"}[5m])),
      0.000000001
    )
  )
  and on() (
    sum(rate(agent_task_terminal_total{status=~"success|error"}[5m])) > 0
  )
```

`agent_task_terminal_total{status="success|error|cancelled"}` is
best-effort process telemetry. A marker in the local task snapshot
deduplicates sequential observations whether the terminal event or the
status write arrives first. It is not a durable, transactional, or CAS
counter: a crash between marker persistence and increment can undercount,
and concurrent replicas can race and double-count. U0 must introduce the
database/outbox boundary before this metric can be treated as an
authoritative durable completion ledger.

Prometheus sums rates across replicas. That is correct while one replica
owns each task, but asymmetric duplicate or missed terminal observations
can bias the ratio (duplicate successes bias it upward; duplicate errors
or missed successes bias it downward). Identical duplicate outcomes often
move numerator and denominator together but still distort traffic volume.
Counter resets are handled by `rate()`, while increments lost before a
scrape are not recoverable. Until U0, use this SLI for operational burn
telemetry and corroborate long-window decisions with durable task records.
`agent_task_invocations_total{status}` remains lifecycle telemetry and is
intentionally not used as the SLI denominator.

### 4. LLM cache freshness (informational)

> Fraction of LLM calls answered from the two-tier cache, used as a
> proxy for cost-stability rather than user-facing reliability.

The unified exporter does not currently expose cache-hit and lookup
families, so this indicator has no Prometheus recording or alert rule.
Langfuse remains the source for the informational dashboard until both
raw counters are added to the unified inventory.

## SLO targets

Targets are written for a 30-day rolling window and enforced through
multi-window burn-rate alerts.

| ID         | SLI                       | Target  | Window  | Error budget |
|------------|---------------------------|---------|---------|--------------|
| SLO-API-1  | HTTP availability         | 99.9 %  | 30 d    | 43 m 49 s    |
| SLO-API-2  | HTTP latency p99 < 1500 ms| 99.0 %  | 30 d    | 7 h 18 m     |
| SLO-AGT-1  | Agent task success        | 99.0 %  | 30 d    | 7 h 18 m     |
| SLO-LLM-1  | LLM cache hit rate ≥ 35 % | n/a     | 30 d    | informational|

> **Why these numbers.** The 99.9 % target on availability matches the
> commercial-tier expectation in the CTO roadmap. The latency targets
> were derived from p99 histograms collected during the load tests in
> `phase-8d-http-integration-testing.md` — anything slower than 1.5 s
> is user-perceptible on the chat surface.

## Alerting policy

We use the Google SRE multi-window, multi-burn-rate scheme:

| Severity | Long window | Short window | Burn rate | Page? |
|----------|-------------|--------------|-----------|-------|
| Page     | 1 h         | 5 m          | 14.4 ×    | yes   |
| Page     | 6 h         | 30 m         | 6 ×       | yes   |
| Ticket   | 24 h        | 2 h          | 3 ×       | no    |
| Ticket   | 72 h        | 6 h          | 1 ×       | no    |

A page fires only when **both** the long and short window are burning
above the threshold. This keeps single noisy minutes from waking
oncall while still catching genuine 30-minute outages.

The Prometheus rules in `prometheus-rules.yml` encode availability,
latency, and agent-success with the same burn-rate scheme. Every SLI has
5 m, 30 m, 1 h, 2 h, 6 h, 24 h, and 72 h recordings. Numerators are
zero-filled where an absent series means zero events; denominators are
clamped; and both ratios and alerts require positive traffic. Idle
windows therefore emit no ratio and cannot burn budget.

HTTP SLOs use dedicated families that never contain route or method:
`siragpt_http_slo_requests_total{request_class,status_class}` and
`siragpt_http_slo_request_duration_seconds{request_class}`.
`request_class` has three values (`standard`, `streaming`, `health`) and
`status_class` has six (`1xx` through `5xx`, plus `other`). Their normal
domains contain at most 18 counter series and three histogram series.
The detailed HTTP families remain available for route diagnostics, but
their single O(1) overflow series folds every label to `__other__`.
Detailed-family overflow therefore cannot remove traffic from SLO
numerators or denominators because SLO rules do not read those families.

### Queue operational thresholds

Queue alerts are operational health signals rather than error-budget
SLOs. They use physical queue names and fixed BullMQ states, so their
cardinality is bounded by the configured queue registry:

- waiting backlog > 100 for 10 m triggers
  `SiraGPTQueueWaitingBacklogHigh`.
- paused backlog > 0 for 5 m triggers `SiraGPTQueuePausedBacklog`.
- retained failed-job backlog > 10 for 15 m triggers
  `SiraGPTQueueFailedJobsRetained`; this gauge is not a failure rate.
- waiting, paused, and retained-failure samples are eligible only from the
  same observer instance where `probe_up == 1` and last-success staleness
  is at most 120 s.
- `SiraGPTQueueProbeDown` pages only when `max by (queue)
  (siragpt_queue_probe_up) == 0`, meaning every replica observer failed.
- mixed observer results trigger warning-only
  `SiraGPTQueueProbePartialFailure`.
- last-success staleness above 120 s triggers warning-only
  `SiraGPTQueueMetricsStale`.

The queue runtime starts a scheduled refresh with the server (30 s by
default, configured by `HEALTH_QUEUE_METRICS_REFRESH_INTERVAL_MS`) and
stops before shutdown. Job gauges are cleared when a queue cannot be
inspected, so stale counts are not treated as current.
`siragpt_queue_probe_last_success_timestamp_seconds{queue}` and
`siragpt_queue_probe_staleness_seconds{queue}` distinguish a current
failure from a silently stopped refresh loop.
See `docs/operations/runbook-queues.md` for triage and remediation.

### Scrape and traffic health

`SiraGPTMetricsScrapeMissing` evaluates the instantaneous condition
`(up == 0) or absent(up)` and holds it with `for: 5m`. It therefore pages
after five continuous minutes of an absent or down backend target, without
double-counting a range window. `SiraGPTBusinessTrafficMissing` is a
separate warning that reads the low-cardinality request counter, zero-fills
missing HTTP series, and excludes `request_class="health"`. It requires at
least one currently healthy backend scrape, so a scrape outage cannot also
masquerade as a business-traffic warning.

## Error-budget policy

- **> 50 % budget remaining** — feature work proceeds normally.
- **20–50 % budget remaining** — risky migrations require a written
  rollback plan; incident retros are mandatory.
- **< 20 % budget remaining** — all non-reliability merges to `main`
  require platform sign-off until the budget recovers above 30 %.
- **Budget exhausted** — code freeze on the affected service except
  for reliability fixes; trigger an incident review.

## Dashboard layout

The Grafana dashboard `siragpt-slo` (provisioned from
`docs/operations/`) renders four rows:

1. **Top-line SLOs** — current 28-day attainment per SLO with a
   coloured single-stat panel.
2. **Burn-rate** — 1 h vs 6 h burn for each SLO, with the page/ticket
   thresholds plotted as horizontal lines.
3. **Drill-down** — `route`-faceted latency and error rate.
4. **LLM cost** — cache hit rate vs $/1k requests (sourced from
   Langfuse via the recorder in `services/observability/llm-cost.js`).

## Per-endpoint tracker (in-process)

In addition to the Prometheus burn-rate rules, the backend keeps an
in-process tracker (`backend/src/services/slo-tracker.js`) that
records per-endpoint counters every request and exposes them through
the shared `/metrics` registry. It is intentionally cheap — no
percentile state, just bucketed counters — and is used for fast SLO
attainment checks without a Prometheus round-trip.

Counters exposed:

- `siragpt_slo_requests_total{route}` — total requests per route.
- `siragpt_slo_requests_under_500ms_total{route}` — fast bucket
  (99.5 % target).
- `siragpt_slo_requests_under_2s_total{route}` — acceptable bucket
  (99 % target).
- `siragpt_slo_errors_total{route}` — 5xx counter (≤ 1 % target).
- `siragpt_slo_available_total{route}` — non-5xx counter (99.9 %
  availability target).
- `siragpt_slo_endpoint_meets_target{route,objective}` — gauge (0/1)
  per objective, useful for at-a-glance dashboards.

Static targets are exposed by `slo-tracker.slos()` and match the
table above; this layer is purely the SLI counter sink.

## Review cadence

- SLO targets reviewed every quarter by the Platform team.
- Alerts reviewed monthly; any alert that fires without an actionable
  outcome twice is either tightened or deleted.
- Error-budget burn reported in the weekly engineering update.
