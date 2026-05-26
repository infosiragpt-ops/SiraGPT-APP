---
name: performance-profiler
description: "Performance profiling and optimization: latency bottleneck identification, memory leak detection, bundle size analysis, and throughput validation."
---

# Performance Profiler

Identify and eliminate performance bottlenecks in SiraGPT.

## Contract

- Profile real user scenarios, not synthetic micro-benchmarks.
- Focus on P95/P99 latencies, not just averages.
- Memory leaks must be fixed before release; do not allow regressions.
- Bundle size must not grow by > 5% per release without justification.
- Agent task execution must complete within SLAs: simple < 2s, complex < 10s.

## Scenarios

### API Response Latency

```bash
# Backend latency baseline
npm run perf:api                        # Runs 100 requests to key endpoints
npm run perf:api -- --concurrent 10    # Concurrent load test

# Inspect slow endpoints
npm run perf:trace -- /api/ai/generate
npm run perf:trace -- /api/agents/run
```

Acceptable: P50 < 200ms, P95 < 500ms, P99 < 1s.

### Frontend Build & Runtime

```bash
# Next.js build performance
npm run build -- --profile              # Generates build profile
npm run perf:bundle                     # Analyzes bundle chunks
npm run perf:runtime                    # Runtime perf (FCP, LCP, CLS)
```

Acceptable: Build < 60s, main bundle < 150KB gzipped, FCP < 2s.

### Agent Task Execution

```bash
# Profile agent task runner
npm run perf:agent -- simple            # Simple task (< 2s)
npm run perf:agent -- complex           # Complex task (< 10s)
npm run perf:agent -- visual            # Visual generation (< 15s)
```

Trace tool registry lookups, task manifest parsing, and sandbox invocation.

### Database Query Performance

```bash
# Query latency on Prisma calls
npm run perf:db -- --slow-log 100      # Log queries > 100ms
npm run perf:db -- --explain            # EXPLAIN on slow queries
npm run perf:db -- --profile migration # Measure migration time
```

Acceptable: P95 < 50ms per query, bulk ops < 500ms.

### Memory Profiling

```bash
# Heap snapshot before/after
npm run perf:memory:baseline
# ... run workload ...
npm run perf:memory:snapshot
npm run perf:memory:compare             # Diff baseline vs snapshot

# Detect leaks
npm run perf:memory:leak -- --threshold 50MB
```

Acceptable: Heap growth < 10MB per 1000 operations.

## Workflow

1. Establish baseline: `npm run perf:baseline`
2. Implement change
3. Re-profile: `npm run perf:profile`
4. Compare: `npm run perf:compare --baseline perf-baseline.json`
5. If regression: revert or optimize
6. If improvement: document & commit

## Optimization Playbook

### Slow API Endpoint

```bash
# Step 1: Identify bottleneck
npm run perf:trace -- /api/endpoint --detailed

# Step 2: Check database
npm run perf:db -- --query "SELECT ..." --explain

# Step 3: Add caching if appropriate
# ... implement Redis cache ...

# Step 4: Re-profile
npm run perf:trace -- /api/endpoint --detailed --after-fix

# Step 5: Commit with benchmark in PR description
```

### Large Bundle

```bash
# Step 1: Analyze chunks
npm run perf:bundle --breakdown

# Step 2: Identify offenders
npm run perf:bundle --top 10  # Top 10 largest imports

# Step 3: Code-split or lazy-load
# ... update import statements ...

# Step 4: Rebuild & measure
npm run perf:bundle

# Step 5: Commit if < 5% regression
```

### Memory Leak

```bash
# Step 1: Capture baseline
npm run perf:memory:baseline

# Step 2: Reproduce workload
# ... run agent tasks, API calls ...

# Step 3: Snapshot & compare
npm run perf:memory:snapshot
npm run perf:memory:compare

# Step 4: Identify retained objects
npm run perf:memory:leak --interactive

# Step 5: Fix (cleanup timers, event listeners, etc.)
# Step 6: Verify fix
npm run perf:memory:leak --threshold 50MB  # Should pass now
```

## Team Rules

- Never merge without baseline perf data in PR.
- Regression > 10%? Fix or reject.
- New endpoint? Measure latency P95 before merge.
- Large bundle change? Run bundle analysis before merge.
- Memory leak suspected? Profile before/after fix.
