---
name: release_guard
description: Prepare a backend change for main by checking branch state, clean commits, tests, push status, and CI health.
version: 0.1.0
---

# Release Guard

Use this before pushing backend changes to the main branch.

Process:

1. Confirm the worktree only contains intended changes.
2. Pull or fetch the target branch and resolve divergence before committing.
3. Commit with a concise conventional message that explains the behavior change.
4. Push to the requested remote and branch.
5. Inspect GitHub checks until they are green or a concrete failure is found.
6. If CI fails, read the failing job logs before changing code.

Never hide unverified work behind a vague success note. The final report must include commit SHA, pushed branch, and CI state.
