---
name: Attachment scaffolding leak + format-request honoring
description: Why injected synthesis/format directives leaked into document answers, and how explicit "N paragraphs" requests must be honored on both the LLM and fallback paths.
---

# Attachment scaffolding leak + format requests

When a document-summary answer is built by the **fallback path** (the react-agent
LLM call failed / returned weak), the fallback reuses the same uploaded-file
context string that the LLM saw. That string contains *injected instructions*
(synthesis directives, "Pregunta del usuario:", batch notices, "N parrafos"
directives). If the strip-list misses any of them, they leak verbatim to the user
and look deeply unprofessional.

## Rule 1 — the strip-list must stay synced with what the context builder injects
**Why:** `buildUploadedFileContext` (message-attachments.js) and the strip-list
(`attachment-context-guard.js` SCAFFOLDING_PREFIXES / SCAFFOLDING_NEEDLES) drift
independently. A new directive line added to the context builder leaks unless a
matching entry is added to the strip-list.
**How to apply:**
- Match **case-insensitively** (lowercase both sides) — "Pregunta del usuario:" vs
  prefix "pregunta del usuario:" silently failed a case-sensitive `startsWith`.
- Prefer **startsWith (PREFIXES)** for directives that lead their own line
  (e.g. "El usuario pidio", "Lote grande detectado", "Para analisis profesionales:").
  Reserve broad **includes (NEEDLES)** for genuinely distinctive mid-line phrases
  only — a broad `includes` needle can strip real document prose.
- Any time you add an injected line to the context builder, add its strip entry in
  the same change.

## Rule 2 — explicit "N párrafos" must be honored on BOTH paths
**Why:** users ask "dame un resumen en 2 parrafos" and expect exactly that. The
LLM-prompt directive and the fallback renderer are two separate code paths; fixing
only one still produces the wrong format whenever the other path runs.
**How to apply:**
- `requestedParagraphCount(query)` (message-attachments.js) is the shared parser —
  returns 0 unless the user explicitly asked for >=2 (so the single-paragraph path
  keeps handling "1 parrafo").
- LLM path: emit an N-paragraph directive in ai.js documentTurnGuard AND in the
  uploaded-file context.
- Fallback path: the summary branch of `buildAttachmentGroundedFallbackAnswer`
  must distribute selected sentences into exactly N paragraphs.
- Distribution must use **remainder-based allocation** (base = floor(len/N), first
  `len % N` paragraphs get +1), NOT fixed `ceil` chunking — `ceil` can yield fewer
  than N paragraphs (e.g. 6 sentences / 4 → 3 blocks), breaking the "exactly N"
  promise.
