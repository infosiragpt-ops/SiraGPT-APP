---
name: searchBrain guardedSearch breaker stale-closure
description: Why the per-provider CircuitBreaker must not capture the query closure at construction.
---

# searchBrain guardedSearch / breakerFor stale-closure trap

`breakerFor(id)` memoizes one opossum `CircuitBreaker` per provider id (to keep
circuit state provider-scoped). The breaker's action is fixed at construction.

**The trap:** if you build the breaker with the *query closure* (`new CircuitBreaker(fn)`)
and call `breaker.fire()`, the FIRST query's closure is captured forever — every
later query on that provider re-runs the first query and returns stale results.
This silently breaks ALL providers across different queries within a process.

**The fix / rule:** construct the breaker with a generic invoker `(fn) => fn()`
and pass the current closure per call via `breaker.fire(fn)`. Circuit state stays
provider-scoped; the executed work is always the current query.

**Why:** opossum binds the action at construction; `.fire(...args)` forwards args
to that fixed action, it does not replace it.

**How to apply:** any memoized-per-key circuit breaker / wrapper must take the
work function as a `.fire()` argument, never bake a request-specific closure into
the cached breaker instance.
