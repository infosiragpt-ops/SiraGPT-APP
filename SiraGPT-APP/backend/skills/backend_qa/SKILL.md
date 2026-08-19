---
name: backend_qa
description: Choose and run focused backend verification for API, agent, RAG, orchestration, and skill-registry changes.
version: 0.1.0
---

# Backend QA

Use this after backend code changes or when deciding which checks are enough for a small patch.

Test selection:

1. Start with the nearest existing test file for the touched module.
2. Add or update a regression test when behavior changed or a bug was fixed.
3. Run only the focused test first.
4. Run the package-level gate when the change touches shared contracts, middleware, auth, routing, schemas, or orchestration.
5. Avoid full-suite runs unless the touched area is broad or the focused gate gives a suspicious result.

Good proof includes the command, pass/fail status, and any skipped checks with a reason.
