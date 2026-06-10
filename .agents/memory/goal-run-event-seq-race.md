---
name: goalRunEvent seq race
description: count()→create TOCTOU causes P2002 bursts; serializable transaction is the fix; listEventsSince needs size cap.
---

## Rule
In `goal-events.js` `appendEvent`, never use `count()` to derive the next seq then `create()` in a separate query. Under concurrent burst (4+ appends at the same ms) all readers get the same count and race to insert the same seq, exhausting the retry loop and returning errors.

**Why:** The unique constraint `@@unique([goalRunId, seq])` makes any TOCTOU read-then-write unsafe under concurrent load.

**How to apply:**
- Wrap the `findFirst({orderBy:{seq:'desc'}})` + `create` in `prisma.$transaction(async tx => {...}, { isolationLevel: 'Serializable' })`.
- Catch `P2002` (unique conflict), `P2034` (serialization failure), and `err.message.includes('serializ')` (raw PG 40001) — all are retryable.
- Retry up to 8 times (not 3); serializable failures are almost always resolved within 2-3 retries.
- In `listEventsSince`, cap `safeLimit` at 200 (not 5000) and add `select:{id,seq,type,payload,createdAt}` to avoid Prisma P6009 (>5MB response).
