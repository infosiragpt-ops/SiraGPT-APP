---
name: Duplicate message deduplication
description: Why and how the chat deduplication logic must handle role case and post-filter adjacency
---

## The rule
`dedupeMessages` must:
1. Compare roles **case-insensitively** in every pass (backend Prisma returns "ASSISTANT", local optimistic uses "ASSISTANT", but external API responses may return lowercase "assistant").
2. Be called **twice** in the render path: once on the raw messages array, then again on the *filtered* (shouldRenderChatMessage) array. Hidden messages (tool-use, metadata stubs) between two identical assistant turns prevent Pass C's adjacent-twins check from firing on the raw array.

**Why:** Pass B (optimistic/stable twin) and Pass C (adjacent stable-id collapse) both check role equality. Case mismatch silently bypassed both passes. Post-filter adjacency was a separate blind spot.

**How to apply:** `lib/message-preservation.ts` Pass B/C use `.toUpperCase()`. `components/chat-interface-enhanced.tsx` rendering wraps stableMessages in a second `dedupeMessages()` call after the `.filter()`.
