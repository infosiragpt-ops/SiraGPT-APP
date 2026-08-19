---
name: User-intent alignment signal extraction
description: Rules for adding deterministic intent signals (tone/length/language/counts) to the per-turn alignment profile without regressing existing consumers.
---

# User-intent alignment signal extraction

The deterministic per-turn intent contract (the "brain" layer that feeds the LLM
prompt) lives in `user-intent-alignment.js`. New signals must be **additive**:
append to `hardConstraints` / `responsePolicy` only and never change the existing
profile shape (`version`, `taxonomy`, `outputMode`, `requestedFormat`,
`groundingMode`), or downstream consumers in the plan/prompt path break.

**Why:** every new keyword regex is a false-positive surface. A blunt keyword
turns ordinary domain language into a phantom user instruction, which then leaks
into the prompt as a hard constraint and degrades the answer.

**How to apply — false-positive guards that actually mattered:**
- Tone/register detection must require *stylistic intent* context, not bare
  domain tokens. `de ventas` wrongly fired `persuasive` on "datos de ventas";
  bare `friendly` fired `informal` on "user-friendly". Anchor to phrases like
  `tono/estilo persuasivo`, `copy de ventas`, drop ambiguous standalone tokens.
- Collective number words (`par`, `docena`) must require an explicit quantifier
  phrase (`un par de`, `una/media docena de`) — otherwise the idiom
  "a la par de documentos" reads as count=2. Handle them separately from the
  plain word-number loop.
- Output-language detection must be anchored to a response-directing verb AND the
  verb→language gap must not cross a source noun (articulos/fuentes/...). Without
  the gap guard, "responde con articulos en ingles" flips the response language.

Text is matched against `normalize()` output (accents stripped, lowercased), so
all patterns are accent-free. Always add **negative** tests for the domain
phrases that previously misfired, not just the positive cases.
