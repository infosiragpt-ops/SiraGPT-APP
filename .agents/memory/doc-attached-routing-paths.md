---
name: Doc-attached routing — edit vs answer
description: Two distinct routing paths for prompts with an attached document, and the pronoun-vs-noun gating that keeps transform verbs from hijacking unrelated prompts.
---

# Doc-attached prompts have TWO routes, both landing on agent_task

When a document is attached, a prompt can be routed two different ways, and they are NOT the same feature:

1. **Source-preserving EDIT** — gated by `isSourcePreservingEditRequest` (backend `source-preserving-document-edit.js`) and, on the frontend, `shouldEditExistingDocument` + `editsExistingDocument` (`lib/ai-service.ts`). This produces an *edited copy of the original file* (Claude-Cowork style). The backend function is the single gate for ALL backend edit paths (`/doc/generate`, `agent-task-runner`, `document-delivery-policy`).
2. **Document ANSWER** — gated by `shouldAnswerFromExistingDocument` + `DOCUMENT_UNDERSTANDING_RE`. This *answers a question about the doc in chat*; it does NOT regenerate or touch the source file.

Both can resolve to `intent === 'agent_task'`. The frontend intent only decides *which agent path*; the backend `isSourcePreservingEditRequest` makes the final edit-vs-answer call. So a prompt routed to agent_task via the ANSWER path will NOT source-preserve-edit (and won't destroy the original) even though both say "agent_task".

**Why:** Understanding verbs like `resume`/`analiza` live in `DOCUMENT_UNDERSTANDING_RE`, and `shouldAnswerFromExistingDocument` treats attachment-only context as a document reference. So "resume esta idea en una línea" with a doc attached routes to agent_task (to answer) — this is intentional, pre-existing, and covered by tests (e.g. "dame un resumen en un solo parrafo" + Word). Do not "fix" it as a false positive without explicitly scoping that work; it risks breaking the answer-path tests.

# Transform verbs require a document NOUN, not just a pronoun

Whole-document transforms (traducir/cambiar/resumir/reformular/parafrasear/sintetizar/transcribir) act on the whole file, so they don't need a sub-region keyword. But matching them on a bare demonstrative pronoun ("traduce **esta** frase", "cambia de tema") while a file happens to be attached caused false source-preserving edits.

**Rule:** transform verbs only count as a source-preserving edit when an explicit document NOUN is present (documento/archivo/word/docx/pdf/tesis/adjunto…), via `EXISTING_DOCUMENT_REFERENCE_RE` on the frontend and the `documentNoun` (not pronoun-only `existingDocRef`) check on the backend. Pronoun-only references are honored ONLY for the structural edit verbs (agrega/modifica/…), which is the original, tested behavior.

**How to apply:** when adding new edit/transform verbs, decide if they are "structural" (region-targeted, pronoun refs OK) or "whole-document transforms" (require a document noun). Keep the backend `structuralEditVerb` vs `transformVerb` split and the frontend `EXISTING_DOCUMENT_EDIT_RE` vs `WHOLE_DOCUMENT_TRANSFORM_RE` split in sync.

# Transform verbs must match VERB forms only — never generic stems

Do NOT match transform verbs with broad stems like `cambi\w*` / `resum\w*` / `traduc\w*`. Those capture the corresponding NOUNS — "cambio", "resumen", "traducción", "síntesis", "paráfrasis", "transcripción", "reformulación" — so a read-only question like "explica el **cambio** del documento" or "¿cuál es el **resumen** del documento?" gets hijacked into a fake source-preserving edit.

**Why:** Spanish nouns share the verb stem. `cambi\w*` matches both "cambia" (verb) and "cambio" (noun). With a document attached + a document noun present, the bad match flips the request into the in-place edit flow.

**How to apply:** enumerate explicit verb endings. For verbs whose noun is `stem+vowel+suffix` (resumir→resumen, reformular→reformulación) you CANNOT use `stem+e\w*` because `\w*` swallows the noun tail — list exact endings and rely on the outer `\b` to reject the noun (after "resume" the "n" of "resumen" fails the word boundary). Formal/usted imperatives change the stem consonant (traducir→"traduzca", sintetizar→"sintetice"), so they need their own top-level alternatives (`traduzca\w*`, `sintetice\w*`) — they are unreachable from the `traduc`/`sintetiz` stems. Both files normalize with NFD + strip-accents + lowercase, so write patterns accent-free and keep frontend `WHOLE_DOCUMENT_TRANSFORM_RE` and backend `transformVerb` identical.
