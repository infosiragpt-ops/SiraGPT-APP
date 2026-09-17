# Scheduled-agent result integrity

## Contract

The canonical scheduler records success only for a recognized terminal agent
result, or its legacy synchronous answer-only contract. Queued/accepted handles,
unknown or malformed statuses, cancellation, errors and exhausted budgets do
not establish completion. For planner/executor output, every planned sub-goal
must have a matching successful terminal result. A successful final synthesis
cannot hide a failed sub-goal. Recovered observations inside ReAct are not
mistaken for failed terminal sub-goals.

The whole agent invocation is never automatically replayed after an ambiguous
transport failure: it may already have performed a write or sent a message.
Safe tool-level retry remains unchanged. A later scheduled occurrence or an
explicit user request is a separate invocation, not an automatic recovery.
`setJobClassifier` remains a no-op compatibility entrypoint for existing boot
wiring. The current Redis acquire/renew/release guard remains unchanged: it
coordinates workers while Redis is available, with the existing explicitly
reported process-local fallback when unavailable. This result contract does
not strengthen that fallback or claim distributed persistence for the JSON
job store. Terminal outcomes, including `tool_circuit_open`, still stop the
renewal timer and release their claim. A skipped overlap does not create a run.

## Provenance and scope

Native adaptation of OpenClaw commit
`b56ddcc6ffdfc5be78c1c9c93926518367b876eb` (MIT), separating execution outcome
from notification delivery. Exact sources and retained license are recorded in
`THIRD_PARTY_NOTICES.md`. AGENTS.md §25 and the explicit fusion request override
the old reference-only restriction in `openclaw-import-audit`; no upstream
gateway, scheduler, fallback provider or retry runtime is activated.

No UI, schema, private configuration, document-sandbox F1 or coverage thresholds
change. Historical journal records are not rewritten.

## Reproducible checks

```sh
NODE_ENV=test node --test backend/tests/scheduler.test.js \
  backend/tests/overlap-lease.test.js backend/tests/cron-as-turn-dispatch.test.js \
  backend/tests/tool-failure-circuit.test.js
npx eslint backend/src/services/scheduler/scheduler.js backend/tests/scheduler.test.js
git diff --check
```

Regression fixtures exercise actual scheduler persistence. Planner/executor and
ReAct are real for the contradictory-plan and recovered-read cases; only the
model SDK is scripted with inert data. No network provider or production jobs
are used. These are local regression/integration tests, not paid-model or live
production acceptance, and are not included in the F1 unit-coverage metric.

The initial tests reproduced false success and a second effect after a simulated
transport failure. Independent review then reproduced `model_error` in a plan
step with outer `finalized`; that case is now an explicit regression.

Revalidated on the published `bcdfa315974141e2509d831c506ff475cf75b4d0` base:
the unmodified scheduler still persisted `tool_circuit_open` as success. The
rebased tests include the real ReAct circuit result plus four terminal lease
lifecycles and an already-held Redis claim. The focused four suites pass
168/168; the native agent lane passes 611/611, with no omissions. Redis transport
is substituted in the lease tests, while scheduler journals and timer lifecycle
are exercised locally. A claim of successful real Redis coordination requires
the additional isolated release smoke; a fake transport is not that proof.

## Release and failure path

Use a reviewed PR to `production-main`, green checks on the final SHA and the
current approved Lenovo publication procedure. Never deploy this document's
instructions as a substitute for reviewing the real publisher and backup.
After publication, verify the exact public SHA and readiness, then exercise a
private test job for successful, failed and cancelled outcomes and confirm one
invocation. This document does not claim those live checks have happened.

On a failed job, inspect its redacted terminal record and confirm effects before
an explicit retry. Do not replay it automatically, erase journals or enable
upstream runtimes to hide the failure. Any rollback follows the reviewed release
procedure, preserving the job store and unrelated changes.
