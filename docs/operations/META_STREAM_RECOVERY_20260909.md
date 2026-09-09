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
Preserve the existing route-level 45-second watchdog's explicit TimeoutError
through SDK cancellation, including a deadline reached before stream dispatch.
Neither deadline's duration changes. A genuine Stop still cancels silently;
an expired deadline produces E_TIMEOUT and cannot initiate another attempt.

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
Four further regressions failed before the parent-deadline fix and pass with it:
route watchdog reason wiring, a deadline while stream creation is pending,
reasoning-only activity when the SDK replaces the reason with AbortError, and
pre-dispatch deadline versus genuine Stop. These fixtures exercise the actual
watchdog decision helper and service transport, not a paid production request.

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

- Focused backend suite: 90 passed, 0 failed, 0 skipped.
- The two-helper unit coverage gate: 100% lines, 97.06% branches,
  100% functions (80% minimum retained in every dimension).
- Type checking, lint, backend build and Next standalone build passed.
  Next retained the existing noVNC target warning; no frontend file changed.
- UI-lock check, scoped secret scan and whitespace check passed.
- Manual logic/security review included cancellation races, late cleanup,
  stream ownership and privacy boundaries. It caught and fixed an early DONE
  for partial answers before the caller could persist them; tests cover both
  caller-owned and service-owned completion. The repository has no `review`
  package script, so no automated reviewer result is claimed.
- An independent source review identified the parent-watchdog/Stop ambiguity;
  the four added regressions cover the correction without changing routing,
  the model selection, timeout durations or credentials.
- Repeated local Node 24 runs exposed a test-runner output deserialization
  failure. The Meta fixture now captures Pino's serialized output and console
  diagnostics in memory instead of sharing the runner's stdout pipe. A new
  assertion verifies real Pino events and privacy filtering; no production
  logger or test threshold is disabled. Five consecutive focused runs passed.

## Publication

Require exact-head CI and review, normal PR merge to production-main, merged-SHA
CI, clean Lenovo checkout, reviewed publisher preflight/backups, SHA/readiness
checks and a genuine authenticated affected-flow smoke. Follow
[the reviewed release runbook](LENOVO_REVIEWED_RELEASE.md).
Any paid acceptance must first have an accredited effective budget within the
previously authorized aggregate US$5; credential presence is insufficient.
Do not report this patch as deployed or successful model generation from unit tests.

### Acceptance checkpoint — 2026-09-09

- Public `/api/version` at 15:06 UTC reported
  `4da7087a90d03a3901ab6ad85fa36011633bca61`; `/api/health/ready`
  reported healthy database, migrations, Redis and RBAC. This is the base
  release, not this patch. Production advanced concurrently from the earlier
  `3656971d055b304e203b9eabd7bee93a481aca0d` observation; any publication
  must refresh the previous-SHA and lock checks rather than reuse that value.
- An authenticated browser session exists. Earlier visible replies from the
  selected model are not a replay of the affected chess request and are not
  acceptance evidence for this patch. No new paid inference was initiated.
- Meta's visible billing control offered spend notification emails, not an
  enforced stop. No payment settings or credentials were changed.
- A normal chat request can also invoke memory extraction, embeddings and
  profile inference, plus frontend reconnection/pending-message retries.
  A maximum for a single Meta API call is therefore not a maximum for the
  authenticated end-to-end flow. Existing estimated budget checks do not
  establish the authorized aggregate US$5 cap.
- Remaining acceptance requirement: an enforced, independently verified
  aggregate reservation/limit covering every billable call (including
  auxiliary calls and uncertain retries), followed by the real affected
  flow. Do not replace this requirement with a catalog GET, synthetic fixture,
  timeout cancellation, an email alert or an assumed low average cost.
