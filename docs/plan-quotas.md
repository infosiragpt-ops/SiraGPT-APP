# Plan-quota enforcement (Phase 8h)

This document is the operator runbook for the plan-quota system that
ships in phase 8h. It complements the inline JSDoc in
`backend/src/services/plan-quota.js` and
`backend/src/middleware/enforce-plan-quota.js`.

## What it is

A small middleware that blocks an HTTP request with **429 Too Many
Requests** when the authenticated user has exhausted the quota of
their plan. The middleware always sets `X-Plan-Quota-*` response
headers so the client UI can render quota state on every request,
allowed or denied.

## What it is NOT

- It does not replace the existing per-endpoint atomic decrement
  logic in `backend/src/routes/ai.js` (four call sites at lines 824,
  3020, 3164, 3299). That code path is battle-tested and unchanged.
- It does not handle rate limiting (per-IP / per-second). That lives
  in `backend/src/middleware/rate-limit-policy.js`.
- It does not bill, charge, or change plan state. The Stripe webhook
  in `backend/src/routes/payments.js` is still the single source of
  truth for `User.plan` mutations.

## Two quota models

The Prisma `User` model carries two orthogonal counters that
historically led to confusion:

| Plan          | Counter field        | Cap field           | Decrements? |
| ------------- | -------------------- | ------------------- | ----------- |
| `FREE`        | `monthlyCallLimit`   | hardcoded **3**     | yes (atomic, in `/api/ai`) |
| `PRO`         | `apiUsage`           | `monthlyLimit`      | no (incremented post-call) |
| `PRO_MAX`     | `apiUsage`           | `monthlyLimit`      | no (incremented post-call) |
| `ENTERPRISE`  | `apiUsage`           | `monthlyLimit`      | no (incremented post-call) |

The `getPlanQuotaSnapshot(user)` pure function in
`backend/src/services/plan-quota.js` normalizes both models to a
single shape:

```ts
{
  plan: 'FREE' | 'PRO' | 'PRO_MAX' | 'ENTERPRISE' | null,
  kind: 'calls' | 'tokens' | 'none',
  used: number,
  limit: number,        // 0 means "unlimited / no enforcement"
  remaining: number,    // clamped to >= 0
  percentage: number,   // 0..1, clamped
  exceeded: boolean,    // percentage >= 1
  warning: boolean,     // percentage >= 0.8 and not exceeded
}
```

A `monthlyLimit` of `0` is treated as **unlimited** (no enforcement),
matching the legacy convention for staff / unlimited accounts.

## Model selector policy

`GET /api/ai/models` returns the existing `{ models }` payload plus a
backward-compatible `policy` object. The policy is user-scoped by the
response cache key and exposes only public quota state:

- `currentPlan`
- `defaultModel` for FREE users
- `fallbackModel`
- `calls`, `premiumTokens`, and `gemaTokens`
- localized-safe notice codes/messages for exhausted pools

The FREE plan places the configured Gema4 fallback first in the text
model list so existing clients that pick the first available model keep
using the intended default. Paid plans keep their existing ordering and
use Gema4 only as an explicit fallback when premium tokens are exhausted.

## Where the middleware is wired

| Route / mount                | Middleware? | Surface label              |
| ---------------------------- | ----------- | -------------------------- |
| `POST /api/document-ai/generate-word` | yes (canary) | `document-ai.generate-word` |
| `POST /api/agent/*`          | follow-up (8h2) | — |
| `POST /api/rag/*`            | follow-up (8h2) | — |
| `/api/ai/*` (chat)           | not changed | (existing in-route enforcement) |

The "canary" route was chosen because it is the **most expensive
single endpoint** (it generates a full DOCX inline, can take 10–30 s,
streams from an LLM provider). Wiring this first lets us validate
the middleware in production without exposing the entire chat
surface to a regression risk.

## Headers always set on a quota-bearing request

```http
X-Plan-Quota-Plan:      FREE | PRO | PRO_MAX | ENTERPRISE
X-Plan-Quota-Kind:      calls | tokens
X-Plan-Quota-Used:      <integer>
X-Plan-Quota-Limit:     <integer>
X-Plan-Quota-Remaining: <integer>
```

These headers also surface on the `429` response so the client
doesn't need a follow-up round-trip to render the quota gauge.

## Telemetry

The middleware emits two PostHog events (no-op when PostHog is not
configured — see `backend/src/services/observability/posthog.js`):

- `plan.quota_warning` — fired once per request when the snapshot
  enters the **warning band** (`>= 0.8` and `< 1.0`). The request is
  allowed through.
- `plan.quota_exceeded` — fired when the snapshot is exceeded
  (`>= 1.0`). The request is then denied (or, if the flag is off,
  allowed through with the event still captured).

Properties: `surface`, `plan`, `kind`, `used`, `limit`, `percentage`,
plus `method` / `path` on the exceeded event for funnel queries.

## Operator runbook

### Disabling enforcement (emergency rollback)

If a bug causes false-positive 429s in production:

```bash
# In your deploy environment, set:
PLAN_QUOTAS_ENFORCED=false
# Restart the backend.
```

What this does:

- Stops returning 429 from this middleware. Existing /api/ai atomic
  decrement is untouched and still enforces.
- **Headers continue to flow** so dashboards keep showing quota
  state.
- PostHog events continue to fire so we can measure "how many
  requests would have been blocked" while the bug is investigated.

### Verifying enforcement is active

```bash
# Hit the canary endpoint with a FREE user that has 0 calls left:
curl -i -H "Authorization: Bearer $TOKEN" \
     -X POST https://api.example.com/api/document-ai/generate-word \
     -d '{"model":"...","prompt":"test","provider":"openai"}'

# Expected:
HTTP/1.1 429 Too Many Requests
X-Plan-Quota-Plan: FREE
X-Plan-Quota-Kind: calls
X-Plan-Quota-Used: 3
X-Plan-Quota-Limit: 3
X-Plan-Quota-Remaining: 0
{"error":"Plan quota exceeded","plan":"FREE",…,"upgradeRequired":true,"surface":"document-ai.generate-word"}
```

### Wiring a new route

```js
const { authenticateToken } = require('../middleware/auth');
const { enforcePlanQuota } = require('../middleware/enforce-plan-quota');

router.post(
  '/expensive-thing',
  authenticateToken,
  enforcePlanQuota({ surface: 'expensive-thing' }),
  async (req, res) => { /* … */ },
);
```

The `surface` label appears in PostHog events so you can filter
"which feature is generating the most quota_exceeded?".

### Migrating /api/ai to the shared module

A future commit (8h2 or later) will replace the four duplicated
atomic-decrement blocks in `routes/ai.js` with a single
`tryConsumePlanQuota(userId, prisma)` helper exported from
`services/plan-quota.js`. The shape of the snapshot returned to the
client will not change; only the implementation moves.

## Tests

- `backend/tests/plan-quota.test.js` (14 cases) — the pure snapshot
  function. Covers FREE call accounting, paid token accounting,
  BigInt normalization, edge cases (negative remaining, over-cap,
  unlimited, anonymous).
- `backend/tests/enforce-plan-quota.test.js` (11 cases) — the
  middleware. Covers anonymous traffic, FREE exhausted vs available,
  paid under/over cap, the read-only mode under
  `PLAN_QUOTAS_ENFORCED=false`, and the env-flag parser.

Run them in isolation with:

```bash
node --test \
  backend/tests/plan-quota.test.js \
  backend/tests/enforce-plan-quota.test.js
```
