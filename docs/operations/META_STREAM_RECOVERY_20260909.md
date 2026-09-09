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
one terminal SSE trailer, preserving backend partial text and the caller's existing
persistence-before-DONE contract for partial answers. Only bounded event/code/status
fields enter failure telemetry, not SDK messages, credentials or conversation text.

No keys, selected models, routing defaults, DNS, schema or visual design change.
An optional, private acceptance policy is off by default; enabling it is a
separate controlled release action described below. This patch cannot guarantee
upstream model availability.

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

### Initial transport-only local results

- Focused backend suite: 90 passed, 0 failed, 0 skipped.
- The two-helper unit coverage gate: 100% lines, 97.06% branches,
  100% functions (80% minimum retained in every dimension). The final expanded
  service-unit command also includes `acceptance-stream-quota.test.js`: 37 tests,
  100% lines, 97.22% branches and 100% functions for these two helpers.
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

### Private acceptance guard — implementation checkpoint

The [private campaign runbook](PRIVATE_META_ACCEPTANCE.md) documents the added
off-by-default transport budget and strict request admission. Reservations are
durable before each physical request, including SDK retries. Uncertain results
are never refunded. Non-accredited providers, modalities, agent queues and
auxiliary operations fail closed in the one bound chat. This is not a global
billing system or acceptance for arbitrary autonomous jobs.

Fresh local checks on Node 24.19.0:

- Guard + admission **unit tests only**: 127 passed, zero failed/skipped;
  100% lines, 99.02% branches, 100% functions for those two modules.
- Separate local integration tests: 4 passed, zero failed/skipped. They cover
  actual installed SDK request/retry behavior with a synthetic transport,
  competing processes, startup failure and an abandoned crash lock.
- CI has a distinct 80% hard unit gate for those two modules; integration
  remains separately discoverable. Document-sandbox coverage is unchanged.
- Type checking, lint, backend build and the final Next standalone frontend
  build passed after the frontend recovery changes and browser QA. Type/lint
  ran as separate gates; the existing noVNC target warning remains.
- Final combined backend regression run (18 files): 286 passed, zero
  failed/skipped.
  This total includes local integration and is not a unit coverage metric.
- Seven failure-lifecycle tests execute the real persistence, normalization
  and browser error-reader branches with synthetic DB/transport boundaries.
  They reproduce the previous false-success behavior and verify failed
  metadata, partial text before terminal error, no premature DONE when storage
  fails, and honest active/history/resume replays. Helper-only coverage:
  100% lines, 98.59% branches, 100% functions. Backend build and syntax checks
  passed again after the lifecycle change.
- Independent review found that private regeneration used an unaccredited
  separate recovery lifecycle. Admission now rejects `regenerate: true` and
  positive regeneration attempts before DB/provider work; ordinary traffic is
  unchanged. Unit tests cover both rejection and normal new-turn envelopes.

The final independent review also found a frontend polling edge: an assistant
row marked failed was accepted as success when the SSE was lost. The correction
changes only runtime logic in `lib/api.ts`, `lib/chat-context-integrated.tsx`
and `lib/recover-persisted-turn.ts`, not JSX, CSS, composer or layout. Exactly
those three entries in the existing 810-file UI lock were refreshed; no files
were removed from the lock. Typecheck passes. The newly introduced hook
dependency warning was corrected instead of suppressed.

Frontend coverage exercises actual client stream recovery paths, matching the
persisted turn identity, Stop during polling, partial EOF/network cuts, late
completion and pending retry cleanup. The private `X-Sira-Acceptance: 1` response
header limits changed partial-EOF behavior to the admitted campaign; its CORS
exposure preserves existing headers and does not broaden allowed origins.
Private failure frames have an explicit boolean discriminator so ordinary
account quotas retain their existing copy/behavior. Partial content stays
visible, failed drafts do not regenerate, and background state is not completed.
This visibility claim is specific to private acceptance failures. The existing
ordinary `E_PROVIDER` bubble error presentation is not changed or claimed fixed.
The new local browser regression is part of the required e2e CI command; its
offline API fixture is not production or model acceptance.

Rendered browser testing also reproduced a real duplicate-placeholder defect:
the compositor's empty `msg-assistant-processing-*` row hid the streaming
`msg-ai-*` row of the same turn. Installation now replaces only the empty
processing row for that exact chat/turn when `skipUserMessage` is true, in both
visible state and chat cache. Existing partials, other identities and attachments
are retained; the global deduplicator and visual components are unchanged.
Two regression tests failed before this fix and pass after it. The final focused
frontend suite currently has 77 passing tests, zero failed/skipped.

Local rendered-browser regression: **3/3 passed, no retries** (desktop failure,
mobile failure and desktop success control). It asserts visible partial text
before releasing the held history request, the correct error/completed state,
one USER/ASSISTANT pair, cleared pending drafts, and no second generation after
online/reload. The mobile case opens the actual history menu to inspect its
terminal badge. Requests use the UI's real serialized envelope with the bound
model and `disableAgentic: true`; every API/identity is synthetic and all remote
egress is blocked. No production, provider or paid acceptance is claimed.
The same three cases also passed against the final compiled Next build served
by `next start` (3/3, no retries). This repeat exercised the local cross-origin
API fixture and explicit exposure of `X-Sira-Acceptance`. Desktop, mobile chat
and the opened mobile history screenshots were visually inspected after
transitions; no fatal page errors, duplicate bubbles or blank app were observed.

The latest public version observed during this work was
`99bc9faafc37f4f3fd31abf488444b4ad30df38c` (checked 16:32 UTC; build 15:34 UTC),
with public readiness healthy. This is **not**
PR #650. Refresh again before any release because another actor publishes here.

Read-only Lenovo preflight at 16:42 UTC confirmed legitimate `deploy` access,
a clean checkout at that same live SHA, the existing private environment mode
`0600`, and no publication lock at that instant. The installed publisher hash
was `51867ea99dd007429446f5f03198015e5659a4b16330829f908500d6eafef634`, matching
the reviewed script. No environment values were printed and no service changed.
These observations must be refreshed before activation; they are not a backup
or acceptance completion claim.

No production campaign file, ledger, environment change or paid inference has
been created by this work. Direct Meta pricing units still require authenticated
verification, followed by private configuration accreditation and a real
authenticated acceptance. Do not report local tests as production readiness.

### First expanded CI run and corrections

[Run 34378793924](https://github.com/infosiragpt-ops/SiraGPT-APP/actions/runs/34378793924)
on `eb0edb21fb28a433de190085e17f1bfc6eae08a9` failed and is **not** release
approval. The required browser gate passed all 22 cases, including the three
new private recovery cases without retries. Backend shard 1, which includes
the separate acceptance unit-coverage gate, also passed.

The frontend job exposed two fixture typing errors in the strict, separate
`tests/tsconfig.json` project. Explicit fixture types and narrowing fix them;
the test compiler now passes locally with `--noEmit`, and the same 77 frontend
regressions pass. Root type checking alone did not cover that project. No
strictness setting or runtime was changed for this correction.

Backend shard 2 encountered an unchanged Redlock test measuring 14 ms of wall
time against three requested 5 ms waits. Its runtime and test were identical
to the production base. The correction is confined to that test: verify the
three scheduled delays and four attempts deterministically, retaining retry
exhaustion and acquisition after release. Do not lower the timing assertion,
skip the test or alter the locking runtime to obtain a green run.
The corrected locking suite passed 20/20, repeated in ten independent local
Node 24 processes (200/200). In-memory mutations to 4 ms, 6 ms or one fewer
retry each failed as expected; the runtime files were not changed. Independent
review found no additional issue in this correction.

The pre-existing job named "Visual regression · pixel-perfect snapshots"
reported success after `No tests found`, because its command masks failure.
It supplies **no pixel-comparison proof** and is not claimed as such. This PR
does not change that job or introduce a baseline. The explicit required
browser cases and inspected screenshots above are the actual UI evidence.
An exact-head CI rerun is required after these test-only corrections; no
auto-merge, merge or deployment was enabled on the failed run.
