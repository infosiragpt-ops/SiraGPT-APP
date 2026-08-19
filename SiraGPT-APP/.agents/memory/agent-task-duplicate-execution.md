---
name: Agent task duplicate execution
description: Why agent_task_worker_started fires many times for one taskId, and the in-flight guard that collapses it.
---

# Duplicate agent task execution

`runAgentTaskJob` (the agent task runner) is the single emit point for
`agent_task_worker_started`, but it is reachable from MANY independent
execution backends for the SAME taskId: the BullMQ worker, the queue→local
handoff watchdog (`runAgentJobInProcess` in routes/agent-task.js), the
local-fallback route, telegram/codex/agent-batch entrypoints, and the Temporal
activity.

**Symptom seen:** deployment logs with `agent_task_queued` once but
`agent_task_worker_started` 10× for the same taskId+jobId.

**Why dedup in audit-log.js did NOT fix it:** that dedup is in-process and only
suppresses duplicate *log lines* within one module's 90s window. It never
prevented duplicate *execution* (and duplicate LLM spend). On the 1-vCPU
Reserved VM the watchdog fires a local run while the BullMQ worker also picks
the job up, and a client reconnecting after the ~30s GCLB response cut triggers
yet another — all of which re-run the full pipeline.

**Fix:** module-level `inFlightAgentTasks` Map<taskId, Promise> wrapper around
the renamed `_runAgentTaskJobImpl`. Concurrent invocations for one taskId share
the same in-flight promise; the entry clears in `.finally()` so sequential
BullMQ failure-retries still run. `fork_join` is unaffected (it derives child
ids `${taskId}-fj-${idx}`).

**Why:** prevents both the log-spam symptom and real duplicate LLM cost.

**How to apply / known limitation:** the guard is PROCESS-LOCAL. It fully covers
the current single-GCE-instance topology (web + watchdog + BullMQ worker all
live in ONE backend process via start-all → backend/index.js). If the topology
ever splits into separate worker/API processes, autoscaled replicas, or a
Temporal worker in its own process, duplicates can return — then you need a
distributed lock (Redis SET NX PX / DB advisory lock) keyed by taskId. Also: a
late BullMQ caller that joins an existing local run executes under the first
caller's `job` object, so BullMQ lock-extend/progress hooks run against the stub
job for that run — low risk today because lockDuration (5min) >> task runtime
(~1min).
