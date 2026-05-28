---
name: ci-orchestrator
description: "CI pipeline orchestration: GitHub Actions workflow optimization, parallel gates, failure triage, and status monitoring."
---

# CI Orchestrator

Optimize and troubleshoot SiraGPT CI pipeline for speed and reliability.

## Contract

- CI must complete within 25 minutes for full suite (main branch).
- PR checks must pass before merge approval.
- Cancelled runs do not count against ratchet metrics.
- Flaky tests = fix, skip, or isolate; never leave flaking.
- Failed job = triage root cause, fix, and rerun; do not force-merge.
- Status checks: frontend build, backend tests, lint, typecheck, security, Docker build.

## Pipeline Structure

### Parallel Paths

1. **Frontend (Next.js):**
   - Build & SSR proof
   - Lint & type-check
   - Bundle analysis
   - ~4 min

2. **Backend (Node/Express):**
   - Unit tests (~2900)
   - Integration tests
   - Security audit
   - ~6 min

3. **Agent System:**
   - Tool registry validation
   - Task manifest checks
   - Sandbox tests
   - ~2 min

4. **Docker & Deploy Prep:**
   - Build Dockerfile.dev
   - Build Dockerfile (prod)
   - Image size report
   - ~3 min

All paths run in parallel; CI overall time = slowest path + merge time (~1-2 min).

## Triage Failures

**Backend test failure:**
```bash
# Identify flaky test
npm test -- <test-name> --repeat 5

# Fix or skip
npm test -- --grep "known-flaky" --invert
```

**Frontend build failure:**
```bash
npm run build 2>&1 | head -30  # Root cause
npm run lint:fix                # Auto-fixes
npm run type-check              # Type errors
```

**Docker build failure:**
```bash
docker build -f Dockerfile.dev .
docker build -f Dockerfile .
```

**Lint/type regressions:**
```bash
npm run lint                    # Exact violations
npx tsc --noEmit --skipLibCheck # Type errors
```

## Workflow

### Pre-Push Local Check

```bash
npm run check:all               # Lint, type, test, coverage, security, review
```

Exit nonzero if any check fails. Fix and rerun before push.

### PR Status Monitoring

Check Actions tab after push:
- Green checkmark = all paths passing
- Yellow circle = still running
- Red X = failure in at least one path

**If red:**
1. Click failed job name
2. Read job logs
3. Identify failure type (test/lint/build/security)
4. Reproduce locally
5. Fix code
6. Push again; CI reruns automatically

### Main Branch Merges

After PR is approved:
1. Squash-and-merge or rebase-and-merge (team choice)
2. GitHub Actions reruns full CI on main
3. Wait for green status (usually 15-20 min)
4. Verify Actions run completed successfully
5. Tag release if needed

### Cancellation Policy

- Newer commit on same PR cancels older runs automatically.
- Manual cancel only if job is stuck > 30 min or resource constrained.
- Do not force-merge around a failed CI run.

## Observability

Check pipeline health:

```bash
# Last 10 CI runs
gh run list --repo SiraGPT-ORg/siraGPT --limit 10

# Latest run details
gh run view --repo SiraGPT-ORg/siraGPT --log

# Specific job logs
gh run view <run-id> --job <job-id> --log
```

## Optimization

Monitor timing in Actions workflow summary. If any path > 7 min:
1. Profile the slow job (add `time` markers)
2. Parallelize sub-tasks
3. Cache dependencies (npm, Docker)
4. Remove unnecessary checks

Update `.github/workflows/ci.yml` with optimizations and tag PR as perf improvement.

## Emergency Procedures

**If CI is down (all runs failing):**
1. Check GitHub status page
2. Review recent `.github/workflows/ci.yml` changes
3. Revert offending change if CI was green before
4. File incident summary

**If specific test keeps flaking:**
1. Isolate the test
2. Run it 10 times locally
3. Fix or skip; document reason
4. Re-enable after fix verified

**If Docker build hangs:**
1. Check Dockerfile for hung command (e.g., `apt-get update`)
2. Add timeout or simplify
3. Test locally first
4. Push & verify CI pass

## Team Checklist

- [ ] Never push without `npm run check:all` passing locally
- [ ] Never merge a PR with red CI status
- [ ] Flaky tests: fix, skip, or isolate (do not ignore)
- [ ] CI down: post in team channel; revert if needed
- [ ] Performance regression: investigate & optimize
