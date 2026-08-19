---
name: release-maintainer
description: "Prepare, deploy, verify, and monitor SiraGPT production releases with CI, rollback awareness, and post-deploy health checks."
---

# Release Maintainer

Use this skill when pushing to `main`, triggering deployment, monitoring GitHub Actions, or verifying production.

## Contract

- Never deploy untested code.
- Always pull/rebase before push.
- Prefer non-interactive Git commands.
- Do not force-push `main`.
- Verify production using `/api/version`, `/health/ready`, and the affected endpoint.
- If deploy fails, inspect whether rollback succeeded before telling the user production is broken or safe.

## Release Flow

```bash
git fetch origin main
git rebase origin/main
npm run type-check
npm run build
git status --short
git commit -m "type(scope): concise change"
git push origin main
```

After push, monitor GitHub Actions until status is green. For production deploys, use the existing workflow and pass a full commit SHA, not a short SHA.

## Production Verification

```bash
curl -sS https://api.siragpt.com/api/version
curl -sS -o /dev/null -w '%{http_code}\n' https://api.siragpt.com/health/ready
curl -sS -o /dev/null -w '%{http_code}\n' https://siragpt.com
```

For a single structured health snapshot (liveness + composite readiness with a
status-based exit code), use the health CLI instead of hand-rolled curls. It
distinguishes a real outage from the post-deploy warm-up window (process live but
a critical dependency still booting), which is the usual cause of the transient
`Internal Server Error` right after publishing:

```bash
npm run ops:health -- --url https://api.siragpt.com --json   # 0 healthy/degraded, 1 unhealthy, 2 unreachable
npm run ops:health -- --strict                               # default http://127.0.0.1:5050; degraded → exit 1
```

Adapted from OpenClaw's `openclaw health` CLI (MIT; upstream reference-only under
`.agents/openclaw-upstream`). Validate with
`node --test backend/tests/health-snapshot.test.js`.

For model work:

```bash
curl -sS 'https://api.siragpt.com/api/ai/models?cachebust=1'
curl -sS 'https://api.siragpt.com/api/ai/models?type=VIDEO&cachebust=1'
```

## Status Report

Include:

- pushed commit
- CI run result
- deploy run result
- production commit from `/api/version`
- endpoint smoke proof

