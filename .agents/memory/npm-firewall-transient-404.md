---
name: Replit package-firewall transient 404 on transitive npm tarball
description: Prod build fails on a specific transitive npm tarball 404 (firewall mirror lag) while dev is fine; pin via overrides instead of retrying.
---

The Replit package-firewall (`package-firewall.replit.local`) can return **404 Not Found**
for a specific transitive npm tarball even when that version is published and valid on the
public registry. This fails `npm ci` during the prod build's install step, while dev keeps
working because its `node_modules` is already populated from a cached install.

**Distinguish from a security block:** a `403 Blocked by Security Policy` is a real
supply-chain block — do NOT retry, remediate the package. A plain **404** ("is not in this
registry" / "name is not valid") on an otherwise-published version is a mirror/ingest gap,
not a security decision.

**How to confirm it's the firewall, not your change:** check whether the offending
lockfile entry changed between the last successful build and the failing one (git log -S on
the dep in the lockfile). If the entry is unchanged and an earlier build with the same
lockfile succeeded, the build is identical and the firewall regressed.

**Do not use curl from the dev container to probe firewall availability** — it 404s for
*every* package (even lodash), so it tells you nothing. Calibrate against a known-good
package before trusting any such probe.

**Fix (deterministic):** pin the problematic transitive dep to a neighboring, older,
well-established version via npm `overrides` in the owning package.json, then regenerate the
lockfile (`npm install --package-lock-only`) and validate with `npm ci --dry-run`. This
removes the build's dependency on the flaky tarball without waiting on the mirror.
**Why:** retrying the same publish gambles on mirror recovery; an override makes the build
reproducible. Choose a version that's API-compatible (same major) — e.g. an AWS resource
detector is a no-op on a GCE VM anyway, so a minor downgrade is safe.
