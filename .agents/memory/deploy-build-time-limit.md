---
name: Deploy build failure modes (OOM + install timeout)
description: gce deploy build can fail two ways — intermittent next-build OOM (primary) and install-phase timeout; how to tell them apart and the levers for each
---

The Reserved VM (`gce`, e2-standard-2: 2 vCPU / 8 GiB) deploy **build phase** has
two distinct failure modes. Both show `status: failed`, `suspendedReason`
undefined, and NO error keyword / firewall 403 in the log. Tell them apart by
WHERE the log ends.

## Mode 1 — intermittent OOM during `next build` (PRIMARY / confirmed)

**Signature:** log dies right as `next build` STARTS — install finished cleanly,
then `next build` never prints "Creating an optimized production build" or any
"Compiled" line. Same code succeeds then fails with NO commits in between
(environmental variance), and timings do NOT match any fixed limit.

**Why:** an 8 GiB builder with the V8 heap cap set too high (was 6144 MB) leaves
too little non-heap headroom for SWC/webpack native allocs + static-generation
worker processes + OS, so peak RSS intermittently crosses 8 GiB → kernel SIGKILL
with no Node error output. Measured: this app's build footprint peaks ~4.2 GiB
during compile+static-gen, so 4096 is comfortably enough and leaves ~4 GiB
headroom.

**Fix / how to apply:**
- Keep `--max-old-space-size=4096` (NOT 6144) in the package.json `build` script.
- Keep `experimental.webpackMemoryOptimizations: true` in `next.config.mjs`.
- PIN `NODE_OPTIONS=--max-old-space-size=4096` explicitly in `.replit`
  `[deployment].build` right before `npm run build`, so an externally-set
  `NODE_OPTIONS` can't bypass the package.json default (`${NODE_OPTIONS:-...}`).
- If it ever recurs after this: add a static-generation worker concurrency cap as
  a tertiary lever (not needed as of this writing).

## Mode 2 — install-phase timeout (~15 min, secondary)

**Signature:** log ends mid-INSTALL (e.g. right after an `npm ci` "found 0
vulnerabilities"); `next build` line never appears AND total duration is
noticeably longer than recent successes (~12–14 min). Two cold sequential
`npm ci` (root ~8 min + backend ~7 min) used to consume the whole budget.

**Fix / how to apply:** run the two installs in PARALLEL via
`scripts/replit-deploy-install.cjs` (wired into `.replit` `[deployment].build`).
Parallel `npm ci` into different dirs is safe (cacache is concurrency-safe);
install is I/O/network-bound so it overlaps well even on 2 vCPU. Keep
`--no-audit --no-fund`, the `rm -rf node_modules backend/node_modules .next`
clean (for the stale `@next/swc` ENOTEMPTY rename bug), and the
`replit-npm-ci.cjs` retry wrapper.

## Editing `.replit`

Direct writes (even a `.replit.edit` sibling) are policy-blocked; use the
`verifyAndReplaceDotReplit({ tempFilePath })` callback with a temp file whose
name does NOT start with `.replit` (e.g. `.local/dotreplit-edit.toml`).
