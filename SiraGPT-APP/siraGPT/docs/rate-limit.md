# Rate limiting

SiraGPT layers three complementary rate limiters at the HTTP edge:

1. **Fixed-window limiter** (`express-rate-limit`, optionally Redis-backed) — coarse "N requests / 15 min" ceiling that stops scrapers and slow-burn abuse.
2. **Per-route / per-user token bucket** (`backend/src/rate-limit/token-bucket.js`) — absorbs short bursts inside the window without raising the ceiling, scoped to `<route>:<principal>` so cheap and expensive endpoints don't share the same budget.
3. **Dynamic cost-based limiter** (`backend/src/rate-limit/dynamic-cost.js`) — extends the token bucket so each handler can report its actual cost (LLM tokens consumed, CPU milliseconds spent, custom signals) and the limiter retroactively adjusts the bucket.

This document covers (3). Layers (1) and (2) are documented in the inline comments of their respective modules.

## Why dynamic costs

Static rate limits assume requests are uniform. SiraGPT endpoints are not:

- `/api/agents/batch` may run a single LLM call (~1 k tokens) or a fork-join of 30 (~60 k tokens).
- `/api/files/*` may parse a 4 KB CSV in 5 ms or a 50 MB PDF over 8 s of CPU time.

Charging both ends of the range the same up-front cost forces a bad trade-off: either you over-throttle the cheap path or you let the expensive path drain the system. Dynamic cost-based limiting closes this gap by reconciling the up-front charge against the work that was actually performed.

## Model

Each request is billed in two phases:

```
┌──────────────┐  initialCost   ┌─────────────┐ report({tokens, cpuMs}) ┌────────────┐
│   request    │ ─────────────▶ │   handler   │ ──────────────────────▶ │ reconcile  │
│              │  (tryConsume)  │             │   (delta = final − up)  │  (adjust)  │
└──────────────┘                └─────────────┘                          └────────────┘
        │                                                                     │
        ├── 429 if upfront cost exhausts the bucket                            │
        │                                                                     │
        └─────────────── reconciliation runs on `finish` / `close` / manual ──┘
```

- **Up-front charge** — `tryConsume(initialCost)`. If the bucket is empty, the request gets a 429 and the handler never runs. This preserves the "burst protection" property of a fixed-cost bucket: an attacker cannot inflate their budget by claiming their requests are cheap.
- **Reconciliation** — once the handler reports actual cost, the limiter computes `delta = finalCost − initialCost` and calls `bucket.adjust(delta)`. The bucket is **clamped** to `[0, capacity]`, so:
  - A runaway report cannot push the bucket negative (no debt carried to the next caller).
  - A refund cannot inflate the bucket past its burst ceiling.

Reconciliation runs at most once per request, on whichever happens first:

- the response emits `finish` (normal end) or `close` (client abort), or
- the handler explicitly calls `req.flushRateCost()` (useful for streaming endpoints that want to bill mid-stream).

## API

```js
const {
  createDynamicCostMiddleware,
  defaultCostFn,
} = require('./rate-limit/dynamic-cost');

app.use(
  '/api/agents/batch',
  createDynamicCostMiddleware({
    route: 'agents:batch',
    capacity: 60,            // burst
    refillRate: 1,           // tokens / second sustained
    initialCost: 1,          // upfront per request
    keyGenerator: makeJwtAwareKeyGenerator(),
    costFn: defaultCostFn,   // or your own
    measureCpu: true,        // auto-measure handler CPU
  }),
  agentsBatchHandler,
);
```

### Reporting cost from a handler

```js
async function agentsBatchHandler(req, res) {
  const result = await runAgents(req.body);

  // Report what the work actually consumed. Multiple calls accumulate.
  req.reportRateCost({
    tokens: result.usage.total_tokens,
    cpuMs: result.cpuMs,         // optional; auto-measured otherwise
    extraCost: result.toolCalls, // optional custom units
  });

  res.json(result);
  // reconciliation happens automatically on `finish`
}
```

For streaming endpoints, flush early:

```js
async function streamHandler(req, res) {
  for await (const chunk of stream()) {
    res.write(chunk);
    if (chunk.usage) {
      req.reportRateCost({ tokens: chunk.usage.tokens });
      req.flushRateCost(); // bill as we go, not at end-of-stream
    }
  }
  res.end();
}
```

### Cost function

The default `costFn` (`defaultCostFn`) implements:

```
cost = baseCost
     + report.tokens / 1000     (1 bucket-token per 1 000 LLM tokens)
     + report.cpuMs  / 100      (1 bucket-token per 100 ms CPU)
     + report.extraCost         (caller-supplied additional units)
```

These weights are conservative: a "typical" 2 k-token, 200 ms request costs ~4 bucket tokens, leaving room for roughly `capacity / 4` such requests per burst. Tune by passing your own `costFn` — it receives `{ baseCost, report, cpuMs }` and returns a non-negative number.

### Headers

Every response carries the standard `RateLimit-*` headers so existing dashboards keep working:

| Header              | Value                                                |
|---------------------|------------------------------------------------------|
| `RateLimit-Policy`  | `<capacity>;burst=<capacity>;rate=<refillRate>/s;mode=dynamic` |
| `RateLimit-Limit`   | `<capacity>`                                         |
| `RateLimit-Remaining` | tokens left after upfront charge (and updated after reconciliation, best-effort) |
| `Retry-After`       | seconds until the bucket can serve again (only on 429) |

The `RateLimit-Remaining` header is updated post-reconciliation only when headers haven't been sent yet. For streaming responses that begin writing before the bucket is reconciled, the header reflects the up-front charge — the reconciled value is observable on the next request.

## Operational notes

- **Bucket scope** is `<route>:<principal>`. Two routes share no state; two users share no state. This is by design — a noisy neighbor on `/api/files/*` cannot starve `/api/agents/batch`.
- **Idle reaping** removes full, untouched buckets after `idleTtlMs` (default 10 min) on a piggy-backed sweep. The hard `maxBuckets` cap handles flood-of-unique-keys scenarios.
- **Replication** — the dynamic cost limiter is in-process. Each replica adapts its own bucket. Global fairness across replicas still relies on the Redis-backed fixed-window limiter sitting in front. Distributed cost reconciliation is feasible (Redis Lua script) and is on the roadmap, but the marginal value over the existing two-layer setup has been low.
- **Late reports** — if a handler calls `reportRateCost` after the auto-flush has fired (e.g. a fire-and-forget Promise that resolves after `finish`), the call is rejected and `req._rateCostLateReport` is incremented. Surface this as a counter in observability if you want to detect handlers that are leaking cost.
- **CPU measurement** uses `process.cpuUsage()` deltas (user + system). Disable with `measureCpu: false` when local CPU is meaningless (proxied requests, async I/O–bound handlers where CPU underestimates real cost).

## Files

| File | Purpose |
|------|---------|
| `backend/src/rate-limit/token-bucket.js` | Core token bucket + registry. Adds `adjust(key, delta)` for retrospective billing. |
| `backend/src/rate-limit/dynamic-cost.js` | Express middleware factory + `defaultCostFn` + `req.reportRateCost` API. |
| `backend/tests/rate-limit-token-bucket.test.js` | Bucket math, registry, base middleware. |
| `backend/tests/rate-limit-dynamic-cost.test.js` | Adjust-clamping, reconciliation paths, manual flush, abort, late reports. |
