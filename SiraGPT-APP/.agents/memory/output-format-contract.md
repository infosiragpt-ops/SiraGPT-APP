---
name: output-format contract
description: Single source of truth for detecting requested answer format (paragraphs, lists, table, length limits) across the document pipeline.
---

All output-format detection (N paragraphs in digit OR Spanish word form, single
paragraph, bullet list, numbered list, table, maxWords, maxSentences) lives in
`backend/src/services/output-format-contract.js`. message-attachments.js, routes/ai.js
(documentTurnGuard) and agent-task-runner.js all delegate to it — never re-implement
these regexes inline.

**Why:** the same format request was detected with divergent regexes in three places,
so "dos párrafos" (word form) and clitic verbs like "enuméralos" behaved
inconsistently and content mentions ("la lista de autores") falsely triggered bullet
formatting and suppressed paragraph directives.

**How to apply:**
- Add any new format cue to the contract module + its test, not to a consumer.
- `requestedParagraphCount()` stays backward-compatible: returns 0 for <2, caps at 6.
- Precedence in `buildFormatDirectiveLines`: structure is mutually exclusive
  (table > numbered > bullet > single > N paragraphs); length limits (maxWords,
  maxSentences) compose on top.
- "lista" only counts as a format request when introduced by a formatting
  verb/preposition (dame/genera/en forma de/etc.) or explicit bullet cues
  (viñetas, puntos clave, checklist) — bare "lista" is treated as content.
