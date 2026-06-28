---
name: Main agent git sandbox
description: Main agent cannot run any git mutation; how to do merges/git work instead.
---

The main agent is fully sandboxed from git mutations. `git merge`, `git fetch`, and even `rm -f .git/*.lock` are rejected with: "Destructive git operations are not allowed in the main agent. Use the project_tasks skill to propose a new background Project Task that will perform this git operation instead." Read-only inspection still works (`git --no-optional-locks log/status`, `git merge-base`, `git merge-tree`, `find .git -name '*.lock'`).

**Why:** Platform safety guard. The main agent works directly on `main`, so git mutations from it are disallowed; only isolated task agents (background Project Tasks) have the system-level protections to perform them.

**How to apply:** Any task whose core work IS a git operation (resolve a merge conflict, rebase, reset, clean, merge a branch) cannot be completed by the main agent even if the user assigns it to main. Write a plan and create a background Project Task (project_tasks skill) so an isolated task agent does the merge in a clean checkout — it is unaffected by stale local `.git` locks (e.g. INDEX_LOCKED). Do NOT evade the guard by string-splitting `.git` paths; respect it and delegate.
