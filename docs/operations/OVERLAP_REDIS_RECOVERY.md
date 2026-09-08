# Scheduled-agent Redis recovery

## Scope

Hardening of the existing native OpenClaw overlap adaptation in
`backend/src/services/scheduler/overlap-lease.js`, shared by the canonical
scheduler and cron-as-turn adapter. Source attribution remains OpenClaw MIT
`b56ddcc6ffdfc5be78c1c9c93926518367b876eb`; LICENSE is retained and the refinement
is attributed in THIRD_PARTY_NOTICES. No new upstream runtime or snapshot files.
AGENTS.md §25 and Luis's explicit fusion request govern this native adaptation;
the older reference-only skill language does not authorize a raw gateway import.

The baseline `1b85ff60514a69edbc9dd244d299b96b944940fa` was reproduced in its
exact backend image with a disposable Redis. The first command, issued before
the lazy client was ready with its offline queue disabled, fell back locally.
Even after Redis reported ready, subsequent acquisitions still ran locally.
This matches the client's documented [connection events and offline queue](https://github.com/redis/ioredis#connection-events),
but the permanent disable decision belonged to SiraGPT, not Redis.

## Contract

- A new lease operation can probe the same configured client after failure;
  there is no process-lifetime disabled latch and no replacement-client leak.
- One Redis command attempt per new acquire/renew operation. Existing production
  connect/command timeouts remain 250 ms; no new retry loop, sleep or config.
- Local-only holders retain their mode until release or TTL expiry. Recovery
  cannot turn one into a second Redis-backed holder in the same worker.
- Same-worker, same-key acquisition attempts are reserved while awaiting Redis;
  reservations clear on success and error. Other keys remain independent.
- A distributed renewal must be acknowledged by token-matching Redis Lua.
  Repeated transport failure, missing client, expired/replaced token cannot
  be reported as successful renewal of the local shadow.
- `redisConfigured` identifies the existing client; legacy `redisAttached` /
  `redisDisabled` snapshot fields retain last-operation availability semantics.
  These aggregate fields never upgrade a local-only claim to distributed.
- No replay of an agent turn, journal rewrite, UI/model/env/schema changes.

## Limits

Redis outage still permits the pre-existing, explicitly reported single-worker
fallback. Multiple workers may run separately during a partition; this is not
global exactly-once execution or fencing of already-running effects. A lost
lease does not cancel the agent here. Recovery does not retroactively coordinate
work that began in local mode. Those policies require separately reviewed work.

## Reproduction and validation

```sh
NODE_ENV=test node --test backend/tests/overlap-lease.test.js \
  backend/tests/scheduler.test.js backend/tests/cron-as-turn-dispatch.test.js \
  backend/tests/tool-failure-circuit.test.js
cd backend && NODE_ENV=test npm run test:openclaw-native
```

The initial eight new regressions failed on the baseline and passed after the
fix. Two additional guards cover a missing client during renewal and cleanup
of denied acquisition reservations. Unit clocks/Redis transport are controlled;
they are not added to document-sandbox F1 coverage.

`node backend/scripts/verify-overlap-redis.cjs` requires a **fresh disposable
Redis on isolated loopback:6379**, never a production Redis service. It reads
no credential environment and does not FLUSHDB. Four cases verify cold-start
recovery, an active local holder, real Redis exclusion, disconnect/reconnect
renewal and replacement-token safety. Its caller must remove the disposable
containers regardless of test outcome. It invokes no model and touches no user
jobs/documents. A candidate-module probe using published image dependencies
passed before PR creation; it is not a claim that the candidate was deployed.

Release follows `LENOVO_REVIEWED_RELEASE.md`: current clean SHA, exact green CI,
normal PR/squash, private DB plus uploads/checkpoint backup, no schema delta,
and the actual reviewed publisher with TARGET/PREVIOUS. Re-run the isolated
probe against the final image, verify public SHA/readiness and preserve the
existing gateway, DB, Redis, DNS and other stacks. Authenticated browser/model
acceptance remains a separate proof, not implied by this deterministic probe.
