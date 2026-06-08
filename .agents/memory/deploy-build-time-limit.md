---
name: Deploy build phase ~15 min time limit
description: gce deploy build step is killed at ~15 min; keep installs fast so next build fits
---

The Reserved VM (`gce`, e2-standard-2: 2 vCPU / 8 GiB) deploy **build phase** has a
hard time limit around ~15 minutes. It is measured from the "Starting Build" log
line, AFTER the separate security-scan and packages phases.

**Symptom of hitting it:** build status `failed`, `suspendedReason` undefined, no
error keyword and no firewall 403 in the logs — the build log just ENDS cleanly
mid-step (e.g. right after the last `npm ci` "found 0 vulnerabilities") and
`next build` never prints a line. Compare durations via `listDeploymentBuilds`:
a failed run noticeably longer than recent successful runs (~12–14 min) = timeout.

**Why it bit us:** two cold `npm ci` installs (root ~8 min + backend ~7 min) ran
SEQUENTIALLY and consumed the whole build budget before `next build` could start.
Install speed varies with npm-registry/network on the builder, so it's right at the
margin — a slow-install day tips it over.

**Fix / how to apply:** keep the build phase well under ~15 min.
- Run independent installs in PARALLEL (see `scripts/replit-deploy-install.cjs`,
  wired into `.replit` `[deployment].build`). Parallel `npm ci` into different dirs
  is safe (cacache is concurrency-safe); install is I/O/network-bound so it overlaps
  well even on 2 vCPU.
- Pass `--no-audit --no-fund --prefer-offline` to trim install time.
- Keep the `rm -rf node_modules backend/node_modules .next` clean (needed for the
  stale `@next/swc` ENOTEMPTY rename bug) and the `replit-npm-ci.cjs` retry wrapper.

**Editing `.replit`:** direct writes (even creating a `.replit.edit` sibling) are
blocked. Use the `verifyAndReplaceDotReplit({ tempFilePath })` sandbox callback with
a temp file whose name does NOT start with `.replit` (e.g. `.local/dotreplit-edit.toml`).
