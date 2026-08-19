---
name: /code auto-repair bridge contract
description: The siragpt:code-fix-error event must auto-SUBMIT a repair turn, not just prefill the composer.
---

The /code live preview signals a failed run by dispatching the window
CustomEvent `siragpt:code-fix-error` (detail.text = captured runner logs). The
chat panel listener is the other half of the contract.

**Contract:** the listener MUST auto-submit a repair turn (with a model →
`sendPrompt` using the SRE system prompt + `autoApply:true`; offline → the
deterministic SRE). It must NOT merely `setInput()`/prefill the composer — if it
only prefills, "auto-fix" silently does nothing because the user still has to
press send.

**Why:** the product owner asked for zero-click auto-fix on failures. A prior
version only prefilled the composer, so failures were never actually repaired.

**How to apply / invariants to preserve:**
- Busy-safe: if a turn is still streaming, wait for idle then fire once (latest
  error wins); never drop the repair just because the chat was busy.
- Synchronous in-flight latch so two same-tick events (auto error + a manual
  "Arreglar con IA" tap) can't launch duplicate repairs before React re-renders.
- The loop is bounded on the PREVIEW side (per-error dedupe + a max-auto-fix
  cap), not in the chat listener — keep the cap there when changing either half.
- Scope is runner BOOT/BUILD failures (the dispatch source). Live dev-server
  iframe runtime errors are opaque-origin and not auto-captured; those stay a
  one-tap "Arreglar con IA" (which now triggers the same real repair submit).
