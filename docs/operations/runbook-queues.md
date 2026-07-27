# Queue alerts

This runbook covers the BullMQ gauges populated by the shared bounded
queue health probe. Queue labels are physical configured names; error
messages and Redis URLs are intentionally never exported.

## Thresholds

| Alert | Condition | Hold time | Severity |
|---|---|---:|---|
| `SiraGPTQueueWaitingBacklogHigh` | fresh successful observer and `max by (queue) (waiting) > 100` | 10 minutes | page |
| `SiraGPTQueuePausedBacklog` | fresh successful observer and `max by (queue) (paused) > 0` | 5 minutes | warning |
| `SiraGPTQueueFailedJobsRetained` | fresh successful observer and `max by (queue) (failed) > 10` | 15 minutes | ticket |
| `SiraGPTQueueProbeDown` | `max by (queue) (probe_up) == 0` | 5 minutes | page |
| `SiraGPTQueueProbePartialFailure` | per-queue `min(probe_up) == 0` and `max(probe_up) == 1` | 5 minutes | warning |
| `SiraGPTQueueMetricsStale` | `max by (queue) (staleness_seconds) > 120` | 5 minutes | warning |

PromQL uses `max by (queue)` for job counts because every backend replica
observes the same global BullMQ queue. Summing replicas would multiply
the real backlog. Probe-down also uses `max`: it pages only when every
replica reports `0`. One failed observer while another reports `1` is a
partial-failure warning, not a queue outage.

Before aggregation, backlog rules retain only samples from the same
`queue,instance` where `siragpt_queue_probe_up == 1` and
`siragpt_queue_probe_staleness_seconds <= 120`. A stale or failed observer
therefore cannot page from a BullMQ count left in Prometheus's lookback
window.

`failed` is BullMQ's retained failed-job count at observation time. It
is a backlog, not a counter or failure rate.

## Triage

1. Compare `siragpt_queue_probe_up{queue="<name>"}` across `instance`.
   If all are `0`, verify shared Redis connectivity and credentials. If
   results are mixed, inspect only the failing backend replica.
2. Check `siragpt_queue_probe_staleness_seconds{queue="<name>"}` and
   `siragpt_queue_probe_last_success_timestamp_seconds{queue="<name>"}`.
   The scheduled refresh defaults to 30 s; sustained staleness above
   120 s means the refresh loop or Redis path is unhealthy.
3. Compare `waiting`, `active`, `delayed`, `paused`, and `failed` in
   `siragpt_queue_jobs{queue="<name>",state="..."}`.
4. Confirm the queue's worker deployment is running and inspect worker
   logs for timeouts, dependency failures, or poison jobs.
5. Sample retained failed jobs in the protected admin queue surface and classify
   the failure before retrying.

## Remediation

- Restore Redis or worker connectivity first when the probe is down.
- For partial observer failures, repair replica-local DNS, network, or
  credentials without declaring the shared queue down.
- Confirm a pause is intentional before resuming a queue; do not move
  paused jobs blindly.
- Scale workers only when jobs are safe to process concurrently and the
  upstream dependency is healthy.
- Retry a bounded sample of transient failures before a bulk retry.
- Do not delete failed jobs until required forensic data is retained.

Resolve the alert only after the probe is up and the relevant count stays
below its threshold for one full alert hold window.

The refresh timer starts and stops with the backend lifecycle. Override
its bounded 30 s default with
`HEALTH_QUEUE_METRICS_REFRESH_INTERVAL_MS` (1–300 seconds).
