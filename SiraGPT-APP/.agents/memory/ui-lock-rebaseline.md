---
name: UI lock re-baseline
description: How to refresh docs/UI_LOCK_HASHES.txt after approved frontend changes
---

# Refreshing the UI lock baseline

`scripts/verify-ui-lock.sh` (`npm run ui-lock:verify`) shasums a fixed frontend
file-set and fails the build on ANY diff vs `docs/UI_LOCK_HASHES.txt`. The
tracked file-set lives in `scripts/ui-lock-files.sh`, shared by both verify and
update so they never drift.

After an *approved* UI/functional change to a locked frontend file, re-baseline
with the dedicated script — do NOT hand-roll a `find | shasum`, it will drift
from `ui-lock-files.sh`:

```bash
npm run ui-lock:update   # scripts/update-ui-lock.sh -> rewrites docs/UI_LOCK_HASHES.txt
npm run ui-lock:verify   # must print "UI lock verified — zero changes"
```

**Why:** the gate is a governance control, not a code change — only re-baseline
for changes the user already approved. Never re-baseline to mask an unapproved
UI edit.

**How to apply:** any edit to a file listed in `docs/UI_LOCK_HASHES.txt` (covers
`app/ components/ hooks/ lib/ styles/` incl. `components/code/*` and
`components/codex/*`, plus root config files — ~548 files) trips the gate; run
update then verify, and the platform commits the refreshed manifest with the
change. main agent CANNOT commit, so just leave the updated manifest in the tree.
