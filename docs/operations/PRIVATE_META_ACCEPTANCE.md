# Private Meta chat acceptance budget

This is an operator-controlled acceptance guard, **not** account billing or a
general-purpose agent budget. It is off unless `SIRAGPT_ACCEPTANCE_CAMPAIGN_FILE`
points to an existing private policy. No production policy is shipped in Git.
Enabling the guard alone is not evidence that a paid test is authorized or safe.

## Scope and prerequisites

- One existing authenticated user and one privately owned, plain-text chat.
  Admission rejects attachments, apps, organizations, shared/project/GPT chats,
  agent tasks, rich history and requests outside the short direct-answer form.
  The client must explicitly send `disableAgentic: true`. Other chats/users
  retain their existing behavior. This does not accredit a chess agent, tools,
  document editing, worker queues or arbitrary autonomous workflows.
  Regeneration (`regenerate: true` or `regenerationAttempt > 0`) is rejected
  before any billable work: its separate persistence/recovery lifecycle is
  outside this new-turn acceptance scope. Ordinary regeneration is unchanged.
- Preserve the selected Meta model and the user's effort/permission settings.
  Only `https://api.meta.ai/v1/chat/completions` with
  `muse-spark-1.3-contributor` and an accredited text body can leave the scoped
  transport. Unsupported endpoints/modalities, redirects and unbudgeted
  auxiliary work are denied; do not replace the model to pass a test.
- An admitted response exposes only `X-Sira-Acceptance: 1` (no identifiers).
  This enables private partial-stream recovery in the browser, including when
  an already-authorized client has a separate API origin. Existing CORS allowed
  origins/credentials are not expanded. Persisted private failures and typed
  SSE refusals remain terminal errors, not successful recovered answers.
- Verify current **direct Meta account** input/output prices, their currency
  and per-million-token units, the context ceiling, and that `max_tokens`
  covers reasoning plus visible output. Record dated, non-secret evidence.
  Catalog prices from a reseller or an email spend alert are insufficient.
- Reconcile earlier acceptance spending/reservations against the authorized
  **aggregate US$5**, including uncertain requests. If it cannot be reconciled,
  do not initialize another US$5 balance or make a paid call.
- Use legitimate authenticated application access for the fixture. Do not
  extract cookies, fabricate an authentication token or inspect unrelated chats.

## Private configuration contract

Policy and ledger are pre-existing regular files, mode `0600`, with no symlinks
or hard links. Their resolved directories must not be group/world writable;
use an application-owned `0700` directory in the existing persistent backend
data volume. Every process that can emit the campaign's requests must share
**the same durable ledger**. Do not use independent staging/replica copies.

Policy fields (values remain private):

- `version: 1`; unique `campaignId`, bound `userId`, bound `chatId`.
- `expiresAt`: finite ISO expiry; expired scope stays blocked, not disabled.
- `ledgerPath`: absolute path in the shared persistent private directory.
- `maxTotalMicros`: authorized remaining conservative balance, at most
  `5000000`; `reservationMicros: 1000000` (one US dollar).
- `pricing.verified`: false until the direct pricing evidence is checked.
- `pricing.inputMicrosPerMillion`, `pricing.outputMicrosPerMillion`: integer
  micro-USD per million tokens, not dollars or cents. Both cannot be zero.
- `pricing.inputTokenCeiling: 1048576`,
  `pricing.outputTokenCeiling: 16384`.

Ledger fields: `version`, matching `campaignId`, `maxTotalMicros`,
`reservationMicros`, `usedMicros`, and ordered `reservations`. Each reservation
has `sequence`, `reservedMicros` and `atMs`. Balance must equal the reservation
sum; the guard never initializes, repairs or resets it. Configure only the path
in the existing production environment after reviewing compose propagation.
Never print, commit or copy that environment or private fixture identifiers.

## Physical request ceiling and crash behavior

Before **each physical HTTP request**, reserve US$1 durably. The worst-case
input plus output cost is computed with exact integer arithmetic, rounding
both components upward; it must fit US$1. At most five requests fit the total
US$5 authorization. SDK retries, application retries and reconnects do not
release previous reservations. Success, timeout, cancellation and unknown
upstream results never refund a reservation. Reservation is a conservative
ceiling, **not a claim of measured provider billing**.

The ledger lock is exclusive. New contents are written and fsynced to a private
temporary file, atomically renamed and directory-fsynced before transport.
Corrupt/missing storage, incomplete writes and abandoned locks fail closed.
There is no age/PID-based lock stealing. Recovery requires stopping campaign
emission and a legitimate operator reconciliation. **Rollback must not restore
an older ledger, reset reservations, create another balance or remove a lock
to make tests pass.** Failed configured startup must not fall back to disabled.

## Reproducible offline checks

From the repository root, run unit coverage independently of integration:

```sh
node --test --test-force-exit --experimental-test-coverage \
  '--test-coverage-include=**/acceptance-spend-guard.js' \
  '--test-coverage-include=**/acceptance-chat-admission.js' \
  --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 \
  backend/tests/acceptance-spend-guard.test.js \
  backend/tests/acceptance-chat-admission.test.js
node --test backend/tests/acceptance-spend-integration.test.js
node --test --test-force-exit backend/tests/acceptance-auxiliary-wiring.test.js \
  backend/tests/acceptance-stream-quota.test.js
```

Integration uses a synthetic transport with the installed OpenAI SDK, concurrent
local processes, process startup and forced process termination. It makes no
paid request. These integration cases are not in the unit coverage denominator.
The new CI gate retains 80% in all three unit dimensions; it does not alter the
separate document-sandbox threshold or skip any existing acceptance requirement.

## Release and real acceptance

Follow [the reviewed Lenovo release procedure](LENOVO_REVIEWED_RELEASE.md):
exact-head CI and review, normal merge, merged-SHA CI, fresh clean checkout,
shared release lock, verified backups and existing queue/checkpoint gates.
Do not enable this private scope until configuration, pricing and the aggregate
balance are accredited. Check actual deployment volume/path/ownership, not only
local fixture results. Preserve Lenovo, the tunnel, DNS and other stacks.

After candidate activation, check public SHA/readiness and submit an authenticated
minimal direct-answer request in the bound chat. Check visible text, terminal
error behavior, persisted history, reconnect behavior and the durable reservation
count. Stop on unexpected paid paths or a relevant failure; retain evidence
without prompts, credentials or private identifiers. A healthy API or HTTP 200
model list does not prove generation. A successful minimal answer does not prove
the user's original autonomous chess request; report those scopes separately.
