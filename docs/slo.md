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

> Fraction of HTTP responses that are not 5xx, excluding 499 client
> aborts.

```
sli_http_availability =
  sum(rate(http_requests_total{code!~"5..",route!=""}[5m]))
  /
  sum(rate(http_requests_total{route!=""}[5m]))
```

### 2. HTTP latency (p99)

> p99 of server-side request duration for non-streaming routes.

```
sli_http_latency_p99 =
  histogram_quantile(
    0.99,
    sum by (le, route) (
      rate(http_request_duration_seconds_bucket{streaming="false"}[5m])
    )
  )
```

### 3. Agent task success

> Fraction of agent tasks that reach the `succeeded` terminal state
> (excluding tasks cancelled by the caller).

```
sli_agent_success =
  sum(rate(agent_tasks_total{status="succeeded"}[5m]))
  /
  sum(rate(agent_tasks_total{status!="cancelled"}[5m]))
```

### 4. LLM cache freshness

> Fraction of LLM calls answered from the two-tier cache, used as a
> proxy for cost-stability rather than user-facing reliability.

```
sli_llm_cache_hit_rate =
  sum(rate(llm_cache_hits_total[5m]))
  /
  sum(rate(llm_cache_lookups_total[5m]))
```

## SLO targets

Targets are written for a 30-day rolling window and enforced through
multi-window burn-rate alerts.

| ID         | SLI                       | Target  | Window  | Error budget |
|------------|---------------------------|---------|---------|--------------|
| SLO-API-1  | HTTP availability         | 99.9 %  | 30 d    | 43 m 49 s    |
| SLO-API-2  | HTTP latency p99 < 1500 ms| 99.0 %  | 30 d    | 7 h 18 m     |
| SLO-API-3  | HTTP latency p99 < 500 ms (read-only routes) | 99.0 % | 30 d | 7 h 18 m |
| SLO-AGT-1  | Agent task success        | 99.0 %  | 30 d    | 7 h 18 m     |
| SLO-AGT-2  | Agent task p99 < 60 s     | 95.0 %  | 30 d    | 1 d 12 h     |
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

The Prometheus rules in `prometheus-rules.yml` are auto-generated for
the availability SLO. Latency and agent-success SLOs are encoded with
the same scheme but parameterised on their own recording rules.

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

## Review cadence

- SLO targets reviewed every quarter by the Platform team.
- Alerts reviewed monthly; any alert that fires without an actionable
  outcome twice is either tightened or deleted.
- Error-budget burn reported in the weekly engineering update.
