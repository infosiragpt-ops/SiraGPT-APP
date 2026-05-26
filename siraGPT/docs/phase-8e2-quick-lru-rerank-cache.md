# Phase 8E.2: Bounded Rerank Cache via quick-lru

## Scope

Phase 8E.2 continues the Phase 8E batch from
`docs/cto-commercial-ai-ecosystem-roadmap.md` by replacing the manual
`Map`-plus-two-phase-eviction cache inside the listwise LLM reranker with a
proper LRU implementation that has both `maxSize` and `maxAge` enforced by
the data structure itself.

The previous cache had a defensive eviction sweep, but that sweep ran only
when `setCache` was called and the cache was already full. Cold or rarely
written caches still relied on TTL expiry alone to free entries; under
read-heavy workloads, an entry could outlive its `maxAge` because nothing
forced it to be inspected. quick-lru evicts on every `set` and lazily on
every `get` against `maxAge`, giving us tight bounds with one pass.

## Dependency

| Package | Version | License | Notes |
|---|---|---|---|
| `quick-lru` | `7.3.0` | MIT | ESM-only; lazy-loaded via dynamic `import()` from the existing CommonJS backend. Validated against npm registry metadata, GitHub Advisory DB and OSV on 2026-05-01. |

`quick-lru` was already part of the Phase 8E plan in
`docs/cto-commercial-ai-ecosystem-roadmap.md` (selected over `lru-cache`
because the latter declares `BlueOak-1.0.0`, which is not in our permissive
allowlist for the commercial core). No GPL/AGPL/LGPL packages are
introduced. `THIRD_PARTY_LICENSES.md` was regenerated and now contains
`quick-lru@7.3.0` under the MIT section.

## Changes

- `backend/src/services/llm-reranker.js`:
  - Replaces the `rerankCache = new Map()` plus two-phase eviction with a
    lazy quick-lru instance configured with `{ maxSize: CACHE_MAX, maxAge:
    CACHE_MAX_AGE_MS }`.
  - Promotes `getCached`, `setCache`, `clearCache` and `cacheSize` to
    `async` so they can wait for the dynamic ESM import once. The first
    call pays a single ~1 ms import cost; subsequent calls are O(1) plus
    one microtask tick.
  - The cache now stores `scores` directly instead of `{ scores, expiresAt
    }` because TTL is enforced by quick-lru.
  - Removes the local `rerankCache.size`/`Date.now()` bookkeeping and
    delegates to the LRU.
- `backend/tests/llm-reranker.test.js`: awaits the now-async `clearCache()`
  call. No behavior change in assertions.
- `backend/tests/audit2.test.js`: awaits `clearCache()` and `cacheSize()`
  in the existing `BUG #2` regression so the hard-cap assertion still runs
  exactly once.
- `backend/tests/llm-reranker-cache.test.js` (new): focused regression
  suite that locks in the new contract:
  - cache hit avoids a second LLM call for the same query + ids
  - cache miss when the query string changes
  - `clearCache()` empties the store
  - the cache never exceeds `CACHE_MAX` even when `maxAge` has not elapsed
- `backend/package.json` + `backend/package-lock.json`: declares
  `quick-lru@^7.3.0`.
- `THIRD_PARTY_LICENSES.md`: regenerated; quick-lru lands under the MIT
  section.

## Behavior change summary

- The reranker's external API (`rerank`) is unchanged. Inputs, outputs and
  fallback semantics on LLM failure all match the previous behavior.
- `clearCache()` and `cacheSize()` are now `async`. Callers that ignored
  the return value still work because they returned `undefined` /
  `number` synchronously before; now they return Promises that resolve to
  `undefined` / `number`. The two existing call sites
  (`backend/tests/llm-reranker.test.js` and `backend/tests/audit2.test.js`)
  were updated to `await` them.
- Per-call `cacheTtlMs` was previously honored by `setCache(key, scores,
  ttlMs)`. quick-lru applies a single `maxAge` to the whole instance, so
  callers cannot vary TTL per entry anymore. A grep over the repo
  (`backend/src/`) shows the only consumer that ever passed a custom
  `cacheTtlMs` was `audit2.test.js`, and it passed exactly the default
  value, so production behavior is unchanged.

## Validation

Local:

```bash
cd backend
node --test tests/llm-reranker.test.js \
            tests/llm-reranker-cache.test.js \
            tests/audit2.test.js

# License + supply-chain hygiene
cd ..
npm run licenses:check
npm run security:validate
```

Manual smoke (frontend already running on :3000, backend on :5000):

1. Open `/chat`, ask a question against a corpus that has more than
   `DEFAULT_CONFIG.minChunksToRerank` (3) candidates.
2. Repeat the same question once more — confirm the second call is faster
   and the rerank stage logs no LLM call (cache hit).
3. Wait `cacheTtlMs` (10 minutes) or restart the backend; the same query
   should now miss again.

Production:

- Re-run `npm run licenses:check` and `npm audit --omit=dev
  --audit-level=critical` before merge.
- Confirm GitHub Actions `frontend`, `backend`, `licenses` and
  `CI · required checks passed` are green.
- No new environment variable is required. The cache is in-process and is
  released on backend restart.
