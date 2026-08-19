---
name: "Forget-me" clears must fail closed across stores
description: Multi-store privacy/delete endpoints must never report success if any backing store's clear failed.
---

# "Forget me" / clear endpoints must fail closed

When a user-facing "delete my data" / "forget me" action spans MORE THAN ONE
backing store (e.g. the enumerable memory document on disk AND the learned
vector facts), the endpoint must NOT return `{ ok: true }` if any single store
fails to clear.

**Rule:** clear each store in sequence; on the first failure, return a non-2xx
with a body that names exactly which stores were/weren't cleared
(`documentCleared`, `vectorCleared`, `partial: true`). The frontend treats any
non-2xx as an error and surfaces it, so the user is never told they were
forgotten while data remains recallable.

**Why:** a swallowed inner `try/catch` around the second store made the clear
endpoint report full success even when the vector store was down — a silent
privacy/data-retention violation. A "forget me" that lies is worse than one that
errors.

**How to apply:** any new multi-store delete/clear path (SiraGPT memory lives in
`backend/src/services/memory-document.js` + the pgvector userMemoryStore, wired
through `backend/src/routes/memory.js`). Test the partial-failure path
explicitly (`backend/tests/memory-route-clear.test.js` stubs the vector clear to
throw and asserts the endpoint does NOT report success).
