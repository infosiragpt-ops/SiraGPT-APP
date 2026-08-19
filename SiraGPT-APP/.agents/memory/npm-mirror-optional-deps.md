---
name: npm mirror flakiness vs optional deps
description: When the Replit package mirror 502s on a non-essential transitive tarball during deploy npm ci, make the top-level consumer an optionalDependency instead of waiting/retrying.
---

Deploy `npm ci` aborts if the Replit package mirror (package-firewall.replit.local)
returns `E502 / 502 Bad Gateway` for any single tarball — even a package the build
never uses. This is intermittent infra: the same tarball can 502 for hours then
recover, and it can fail across multiple versions of the same package while the rest
of the tree downloads fine.

**Rule:** If the unservable package is a *transitive* dep of a build-irrelevant
devDependency (e.g. a license/audit tool used only by manual scripts, not by the
deploy build / tests / prepare hook), move that top-level consumer from
`devDependencies` to `optionalDependencies` in BOTH root and backend package.json.
npm treats optionalDependencies and their entire subtree as non-fatal on install
failure, so `npm ci` completes through a mirror 502 yet still installs the tool when
the mirror is healthy.

**Why:** "Just retry / contact support" is the documented response to infra flakiness,
but when retries keep failing and the offending dep is non-essential, optional-dep
hardening removes the single point of failure permanently. Better than deleting the
dep, which would drop the tooling capability entirely.

**How to apply:**
- Confirm the only path to the bad package via `npm ls <pkg>` (root AND backend trees).
- Confirm the consumer is not in the deploy build path: check `build`, `prepare`, and
  test scripts in package.json.
- After editing manifests, regenerate lockfiles with
  `npm install --package-lock-only --ignore-scripts` (the `prepare: husky` hook touches
  `.git` and the sandbox blocks that; omitting --ignore-scripts fails). Skipping the
  regen makes `npm ci` fail on lockfile mismatch.
- Verify the subtree is `"optional": true`, the bad package is gone from the mandatory
  tree, no unrelated version drift, and `npm ci --dry-run` exits 0 for each manifest.
