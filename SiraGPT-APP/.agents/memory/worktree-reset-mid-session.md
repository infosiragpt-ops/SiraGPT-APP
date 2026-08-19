---
name: Working tree reset mid-session
description: Uncommitted main-agent edits can be silently wiped by an external git reset / checkpoint rollback between turns; re-verify on-disk state before trusting earlier edits.
---

Main agent works directly on the `main` branch and is BLOCKED from git mutations
(commit/merge/reset/checkout). Its file edits live only in the working tree until
the platform auto-commits at task end.

**Observed:** after editing several files and confirming them on disk (sed re-read
showed new content, backend `node --test` passed against the edited symbols), a
later `git status` came back CLEAN and the files had reverted to committed HEAD —
`git reflog` showed `HEAD@{0}: reset: moving to HEAD`. The edits were gone. This is
consistent with a user checkpoint rollback or an automated git-repair, NOT with the
workflow restart (the start scripts do no git ops).

**Why it matters:** a stale mental model ("my edits are on disk because the edit
tool + tests confirmed them") can be invalidated between turns. It also makes the
architect look "wrong": when pointed at the post-reset tree it correctly reports the
edits are absent, contradicting your own earlier (pre-reset) verification.

**How to apply:**
- Before relying on earlier uncommitted edits (especially after a restart, a long
  gap, or a confusing architect result), run `git --no-optional-locks status` and
  re-grep the actual symbols on disk. Trust the live tree over your memory of edits.
- If an architect review and your own passing tests disagree, suspect a tree change:
  re-check on-disk state and the count/identity of the test files it ran.
- A merge conflict that only existed in the working tree disappears if the tree is
  reset to a clean committed HEAD — confirm whether the build problem still exists
  before re-doing uncommittable resolution work.
