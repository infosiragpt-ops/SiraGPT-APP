---
name: bugfix-sweep
description: "Run a narrow, high-confidence bugfix pass across SiraGPT without broad refactors or UI changes."
---

# Bugfix Sweep

Use this skill when the user asks for autonomous functional improvements, reliability fixes, or cleanup across the project.

## Contract

- Fix only issues with clear evidence and narrow ownership.
- No broad redesigns, speculative rewrites, or visual interface changes.
- Prefer existing services, helpers, tests, and project patterns.
- Leave unrelated dirty files alone.
- One coherent commit per functional batch.

## Sweep Loop

1. Pull/rebase latest `main`.
2. Inventory changed/relevant areas with `rg` and tests.
3. Pick one high-impact lane: models, chat persistence, provider routing, deploy, docs, security, or agents.
4. Read the owning module and adjacent tests.
5. Patch the smallest root-cause fix.
6. Add/update focused tests.
7. Run focused tests, type-check, and build when production-facing.
8. Commit, push, monitor CI/deploy as requested.

## Skip Criteria

- Root cause uncertain.
- Requires product/design decision.
- Requires new UI.
- Would touch secrets or external accounts without explicit permission.
- Better handled as a larger architecture project.

## Output

Report:

- files changed
- behavior improved
- tests run
- commit SHA
- CI/deploy status

