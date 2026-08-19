---
name: Double AI response bug
description: Two root causes for duplicate assistant messages saved to DB; fixes applied to backend and frontend.
---

## The bug
User sends a message and gets TWO identical assistant replies — both saved to DB with different IDs, both showing action buttons.

## Root causes

### Cause 1 — activeGenerateTurns entry deleted too early (backend)
`activeGenerateTurns` (in `backend/src/routes/ai.js`) is a per-`userId:chatId:content` in-memory lock that lets concurrent/retry requests wait for the first generation and replay its result.

**Before the fix**: the finally block deleted the entry *immediately* when the request ended. If the client's SSE connection dropped (TCP hiccup, Replit proxy gap) and the client retried within seconds, the entry was already gone → second generation + save.

**Fix**: on successful completion (`turn.settled = true`), defer deletion by 120 s via `setTimeout`. Retries arriving within that window find the already-resolved promise and get a `streamDuplicateTurnReplay` response instead of a new generation.

### Cause 2 — retryPendingMessage triggered AI even when assistant already answered (frontend)
`retryPendingMessage` in `lib/chat-context-integrated.tsx` is the offline-resilience path: pending messages (saved to localStorage by `savePending` at the start of `addMessage`) are retried on reconnect/reload.

**Before the fix**: it checked whether the USER message was already echoed in the chat (`alreadyEchoed`), but called `addMessage(..., skipUserMessage=alreadyEchoed)` regardless. `addMessage` with `skipUserMessage=true` still fires `generateAIStream` — so if the AI had already responded before the reload, a second AI call was made.

**Fix**: after finding the echoed user message, check whether an ASSISTANT message with non-empty content follows it. If yes, return `true` immediately (clearing the pending entry) without calling `addMessage`.

## Related windows also increased
- `findRecentCompletedDuplicateTurnForUser` call in the generate handler: 5 s → 120 s
- `findRecentCompletedDuplicateTurn` call inside `saveChatAndTrackUsage`: 15 s → 120 s

**Why:** the default 5 s / 15 s windows were too short for slow generations or retries with backoff delay.

## How to apply
Any future guard on duplicate AI responses should check:
1. Is the per-chatId in-memory turn still active? (covers concurrent requests)
2. Has the turn been completed within the last 120 s? (covers retries after TCP drop)
3. On the client retry path, is there already an ASSISTANT reply in the chat? (covers page reload after stream completed)
