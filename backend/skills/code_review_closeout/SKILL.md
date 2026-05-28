---
name: code_review_closeout
description: Perform a final backend code review focused on regressions, missing tests, runtime hazards, and maintainability before shipping.
version: 0.1.0
---

# Code Review Closeout

Use this after implementation and before final delivery.

Review order:

1. Re-read the diff, not just the edited files.
2. Look for broken imports, async error paths, schema drift, stale docs, and test gaps.
3. Check compatibility with existing callers and default options.
4. Confirm no UI changes slipped into backend-only work.
5. Prefer fixing clear issues immediately; report uncertain concerns as residual risk.

Output findings first when problems exist. If no issues are found, say that plainly and list the verification that supports it.
