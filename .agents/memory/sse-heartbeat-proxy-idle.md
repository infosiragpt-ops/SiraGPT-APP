---
name: SSE heartbeat vs proxy idle timeout
description: Why SSE keepalive interval must be shorter than the pre-first-token window to avoid ECONNRESET + duplicate-turn replays in prod.
---

# SSE heartbeat must outpace proxy idle timeout

SiraGPT streams `/ai/generate` (and image-gen, webdev) over SSE through the
Next.js rewrites proxy (`/api/* → 127.0.0.1:5050`) and the Replit edge. The
backend flushes a `start` event at t=0, then runs enrichment (file processing,
memory/context retrieval, custom GPT/project injection) that can take 6+ seconds
before the first model token.

**Rule:** the SSE keepalive heartbeat interval must be comfortably shorter than
that silent pre-first-token window. It was 15s; a 6.3s first-token turn sent zero
heartbeats in that gap, so an idle proxy reset the socket. Set to 5s.

**Why:** when the socket resets mid-handshake, the symptom chain in prod logs is:
1. `[Error: aborted] { code: 'ECONNRESET' }` — logged by the **Next.js** process
   (no `[backend]` prefix); it's the rewrites proxy's upstream connection.
2. Client (`lib/api.ts` generateAIStream) reconnects — up to 5 attempts, but ONLY
   while `!hasDeliveredAnyContent`, reusing the SAME request body.
3. Backend sees the original turn still active (same userId+chatId+prompt+files)
   → `[ai/generate] active duplicate turn replayed` → streams the original result.
4. Metrics show `aborted:false` — the first turn completed fine; the user got the
   answer. The machinery is recovery working as designed, not data loss.

**How to apply:** if users report ECONNRESET / duplicate-turn noise, first check
the heartbeat interval vs typical first-token latency, NOT the dedup/reconnect
logic (those are correct). Other SSE routes (artifact.js, math.js, viz.js,
doc.js, chats.js, goals.js) still use 15s — bump them only if they show the same
long silent pre-output window. Heartbeats are client-safe no-ops: `: ping`
comment lines are skipped, and `data:{type:'heartbeat'}` has no
content/replace/error fields so handlers fall through.
