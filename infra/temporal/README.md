# Sira Temporal Worker (Temporal Cloud, separate Autoscale Repl)

Durable workflow runtime for `agent-task-worker.js`. The main backend
publishes workflow start requests via `temporal-client.js`; this Repl
hosts the actual worker process that executes them on Temporal Cloud.

This directory is **infrastructure config + a worker entry point**. The
file `worker.js` is the only thing that runs here — the main backend
never imports it.

---

## Why this exists

`backend/src/services/agents/agent-task-worker.js` hand-rolls everything
Temporal gives you out of the box:

| BullMQ hand-roll (today)                              | Temporal equivalent             |
|-------------------------------------------------------|----------------------------------|
| `AGENT_WORKER_LOCK_DURATION_MS` (5 min)               | Activity `heartbeatTimeout`     |
| `AGENT_WORKER_STALLED_INTERVAL_MS` + `MAX_STALLED`    | Built-in worker liveness        |
| `classifyTaskError` + `AGENT_TASK_MAX_RETRIES` + jitter | `retry` policy on the activity |
| `isTransientRedisError` + throttled warn logger       | Native task-queue back-pressure |
| Dead-letter queue (manual)                            | Workflow history + failures UI  |

Migrating one task type at a time behind `USE_TEMPORAL_FOR_<TYPE>=1`
lets us A/B against the BullMQ path before deleting the old worker.

## Architecture

```
   ┌──────────────┐  workflow.start(...)  ┌─────────────────────┐
   │ Sira backend │ ─────────────────────▶│   Temporal Cloud    │
   │ (Autoscale)  │                       │  namespace=sira-prod │
   └──────────────┘                       └─────────┬───────────┘
                                                    │ task-queue poll
                                                    ▼
                                     ┌─────────────────────────────┐
                                     │ Sira Temporal Worker (this) │
                                     │ runs runAgentTaskActivity   │
                                     └─────────────────────────────┘
```

The activity delegates to the *same* `runAgentTaskJob` function the
BullMQ worker uses today — only the scheduling/retry plumbing changes,
so an A/B comparison between the two paths is meaningful.

## Provisioning Temporal Cloud

1. Sign up at <https://cloud.temporal.io>. Create a namespace named
   `sira-prod` in the region closest to the backend Autoscale region
   (us-east for the current Sira deployment).
2. In the namespace, generate either:
   - **mTLS certs**: download the client cert + key PEMs, or
   - **API key**: create one with the `default` role.
3. Note the namespace endpoint, e.g. `sira-prod.a1b2c.tmprl.cloud:7233`.

## Deploying the worker

1. Create a new Repl of type "Node.js" named "Sira Temporal Worker".
2. Copy this `infra/temporal/` directory and the `backend/` directory
   into it (the worker `require()`s into the backend tree to share
   `agent-task-runner.js` and friends — same monorepo layout as the
   main app).
3. Install deps: `pnpm add @temporalio/worker @temporalio/activity
   @temporalio/workflow @temporalio/common` (versions pinned in the
   main backend's package.json once the flag goes live).
4. **Set secrets** in this Repl (NOT the main backend Repl unless you
   also enable the client there — see "Wiring the backend" below):

   | Secret                  | Value                                                |
   |-------------------------|------------------------------------------------------|
   | `TEMPORAL_ADDRESS`      | `sira-prod.a1b2c.tmprl.cloud:7233`                   |
   | `TEMPORAL_NAMESPACE`    | `sira-prod`                                          |
   | `TEMPORAL_TASK_QUEUE`   | `sira-agent-tasks`                                   |
   | `TEMPORAL_CLIENT_CERT`  | PEM (or base64-encoded PEM)                          |
   | `TEMPORAL_CLIENT_KEY`   | PEM (or base64-encoded PEM)                          |
   | `TEMPORAL_API_KEY`      | (alternative to cert+key)                            |
   | `DATABASE_URL` …        | every secret the main backend uses for the runner    |

5. Run `node infra/temporal/worker.js`. Expected output:
   `[temporal-worker] ready namespace=sira-prod taskQueue=sira-agent-tasks …`
6. Publish as a Reserved-VM deployment (NOT Autoscale — the worker is
   a long-running polling process, not request-driven). Min/max
   instances = 1 for the first week, then scale horizontally by
   bumping the count; Temporal load-balances tasks across workers
   automatically.

## Wiring the backend

Add the same secrets to the main Sira backend Repl. With them set,
`shouldUseTemporalForTaskType('research')` flips to true whenever
`USE_TEMPORAL_FOR_RESEARCH=1` (or `USE_TEMPORAL_FOR_ALL=1`).

Per-task-type rollout flags:

| Flag                                | Effect                                                    |
|-------------------------------------|-----------------------------------------------------------|
| `USE_TEMPORAL_FOR_ALL=1`            | Route every task type through Temporal                    |
| `USE_TEMPORAL_FOR_RESEARCH=1`       | Only research tasks (start here — highest-impact, lowest-risk) |
| `USE_TEMPORAL_FOR_DEEP_RESEARCH=1`  | Long-running deep research                                |
| `USE_TEMPORAL_FOR_BATCH=1`          | Batch jobs                                                |
| (unset)                             | Falls back to the existing BullMQ worker                  |

The task-type string is normalized to UPPER_SNAKE_CASE, so
`'deep-research'`, `'deep_research'`, and `'DeepResearch'` all map to
`USE_TEMPORAL_FOR_DEEP_RESEARCH`.

## Validation runbook

```bash
# 1) From the main backend Repl shell, after setting TEMPORAL_* secrets:
node -e "(async()=>{const c=await require('./backend/src/services/agents/temporal/temporal-client').getTemporalClient();console.log(c?'ok':'disabled');process.exit(0)})()"

# 2) From the worker Repl, watch the log:
#    [temporal-worker] ready namespace=sira-prod taskQueue=sira-agent-tasks
# Then trigger one research task from the UI with the flag on; the
# Temporal Cloud dashboard should show a workflow execution within ~1s.
```

## Rollback

If a Temporal-routed task type misbehaves:

1. Unset the per-task flag (e.g. delete `USE_TEMPORAL_FOR_RESEARCH`).
   The next job of that type goes through BullMQ.
2. In-flight Temporal workflows for that type keep running on the
   worker until completion or timeout — Temporal does not cancel them
   on flag flip. To kill one, click "Terminate" in the Cloud UI.
3. To completely disable from the backend without redeploying the
   worker, unset `TEMPORAL_ADDRESS` — `getTemporalClient()` returns
   null and every dispatch path falls back to BullMQ.

## What this turn does NOT do

- Provision the Temporal Cloud namespace (manual user step — needs a
  credit card + cert generation).
- Stand up the actual "Sira Temporal Worker" Repl (manual user step).
- Migrate any real task type to dispatch via Temporal — the wiring
  hook is in place but stays dormant until `USE_TEMPORAL_FOR_<TYPE>=1`
  is set with a healthy `TEMPORAL_ADDRESS`.
- Delete any BullMQ code in `agent-task-worker.js` — the legacy path
  stays primary until each migrated task type has run cleanly on
  Temporal for 7 days (see step 5 in the task plan).
- Install `@temporalio/*` into the main backend `package.json` — done
  in a follow-up once the worker Repl is live, so we don't ship
  dead deps in the main image during the dormant window.
