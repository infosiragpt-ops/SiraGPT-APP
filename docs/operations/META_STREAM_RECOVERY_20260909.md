# Chat stream recovery — 2026-09-09

## Observed boundary

- Production log classification recorded a Meta first-byte timeout at
  2026-09-09T01:07:28Z. The public response was a generic connection error.
- The connection is stored in AdminConnection and loaded into the application
  process at startup. Missing Docker environment variables alone do **not**
  prove an absent credential.
- A read-only /v1/models check accepted the existing connection (HTTP 200)
  and listed the selected model. This is **not** successful generation proof.

## Change

Keep the existing 30-second first-byte deadline. Race both stream creation and
iterator reads against its signal; dispose streams arriving after cancellation.
Do not automatically open another potentially billable request after an
unacknowledged timeout. Disable SDK retries for these application-owned attempts.
Once reasoning/tool activity has been delivered, do not replay it on retry.
Count tool deltas as progress. Keep user cancellation distinct from deadline.

Return stable Spanish E_TIMEOUT/E_PROVIDER/E_PARAMS/E_QUOTA errors and exactly
one terminal SSE trailer, preserving partial text and the caller's existing
persistence-before-DONE contract for partial answers. Only bounded event/code/status
fields enter failure telemetry, not SDK messages, credentials or conversation text.

No keys, models, routing defaults, DNS, schema, UI files or production flags change.
This patch cannot guarantee upstream model availability.

## Reproduction and gates

The two service regressions (uncooperative stream creation and duplicate reasoning)
were run against the unchanged baseline and both failed. They pass with this patch.
Additional fixtures exercise hung iteration, Stop, late stream cleanup, healthy
tool/text progress, partial failure, SDK aborts and safe error classification.
All test provider transports are synthetic; no paid inference is performed.

Run with the repository Node runtime:

    node --test --test-force-exit backend/tests/meta-muse-spark-generate.test.js \
      backend/tests/generate-provider-pin.test.js backend/tests/reasoning-stream.test.js \
      backend/tests/ai-service-http-timeout.test.js backend/tests/ai-generate-log-safety.test.js \
      backend/tests/ai-generate-observability.test.js
    node --test --test-force-exit --experimental-test-coverage \
      '--test-coverage-include=**/generate-stream-guard.js' \
      '--test-coverage-include=**/generate-sse-close.js' \
      --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 \
      backend/tests/meta-muse-spark-generate.test.js

The focused coverage gate is for these two helpers only, not an application-wide
coverage claim. Existing test discovery includes the expanded Meta suite.
No thresholds or acceptance requirements are relaxed.

### Local results

- Focused backend suite: 85 passed, 0 failed, 0 skipped.
- The two-helper unit coverage gate: 100% lines, 96.94% branches,
  100% functions (80% minimum retained in every dimension).
- Type checking, lint, backend build and Next standalone build passed.
  Next retained the existing noVNC target warning; no frontend file changed.
- UI-lock check, scoped secret scan and whitespace check passed.
- Manual logic/security review included cancellation races, late cleanup,
  stream ownership and privacy boundaries. It caught and fixed an early DONE
  for partial answers before the caller could persist them; tests cover both
  caller-owned and service-owned completion. The repository has no `review`
  package script, so no automated reviewer result is claimed.

## Publication

Require exact-head CI and review, normal PR merge to production-main, merged-SHA
CI, clean Lenovo checkout, reviewed publisher preflight/backups, SHA/readiness
checks and a genuine authenticated affected-flow smoke. Follow
[the reviewed release runbook](LENOVO_REVIEWED_RELEASE.md).
Any paid acceptance must first have an accredited effective budget within the
previously authorized aggregate US$5; credential presence is insufficient.
Do not report this patch as deployed or successful model generation from unit tests.
