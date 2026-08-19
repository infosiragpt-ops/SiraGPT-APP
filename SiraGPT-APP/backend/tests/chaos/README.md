# Chaos / Resilience Tests

These tests inject synthetic failures into the **boundary** layer (DB, Redis,
SMTP, Stripe, AI providers) to verify that backend routes / utilities degrade
gracefully instead of hanging, crashing, or returning 500s with unsanitised
stack traces.

## Contract

Every chaos test in this folder must:

1. **Mock the external dependency** — never touch a real network. Use the
   existing `src/chaos/provider-mock.js` for AI providers, or a hand-rolled
   stub object for DB/SMTP/Stripe.
2. **Exercise the unit under test as a black box** — call the route handler
   or utility exactly as production code would.
3. **Assert on observable behaviour**:
   - HTTP status code (typically `503` for upstream failures, `400` for bad
     input, `429` for rate limits).
   - No process-level side effects (no unhandled rejection, no `process.exit`).
   - Resources released (timers cleared, sockets closed, breakers tracked).
4. **Finish within ~2s wall time**. Long-running chaos belongs in `scripts/`,
   not unit tests.

## What lives here

| File | What it covers |
|------|----------------|
| `db-timeout.test.js`           | Prisma client surfaces a timeout → route returns 503, breaker increments |
| `redis-down-smoke.test.js`     | Rate-limiter falls back to in-memory when Redis throws on every op |
| `stripe-bad-signature.test.js` | Webhook returns 400 when `constructWebhookEvent` throws |
| `smtp-timeout.test.js`         | Mail send wrapped in `withRetry` does not hang past its deadline |
| `ai-provider-5xx.test.js`      | OpenAI/Anthropic 5xx → retry-with-backoff exhausts, classifies as retryable, propagates a 503-shaped error |

## Why not `nock`

`nock` is not a backend dep and pulling it in for a single test file isn't
worth the supply-chain surface. We replace target modules at the seam (the
service object, the prisma client, the chaos provider). Tests are
deterministic and run under `node --test` with no flags.

## Running

```bash
node --test backend/tests/chaos/*.test.js
```

These tests are *not yet wired into the main `npm test` shard* — they're
opt-in until the parent agent decides to include them in CI.
