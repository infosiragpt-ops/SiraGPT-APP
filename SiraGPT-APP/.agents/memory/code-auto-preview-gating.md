---
name: /code auto-preview gating
description: Why the /code live preview sometimes didn't auto-rerun after an agent result, and the invariant the fix relies on.
---

# /code auto-preview rerun gating

The /code agentic app-builder must re-run the live preview automatically after
every agent result (the owner explicitly refuses to click "Ejecutar"/Run). Two
**independent silent kill switches** can each suppress that auto-rerun:

1. **Dispatch gate (chat panel):** historically the run event was only dispatched
   when the applied batch contained `package.json`. Any edit that didn't touch
   package.json never asked the preview to rerun.
2. **Signature dedupe (preview pane):** `projectSignature` only fingerprinted the
   *content length* of a small fixed list of key files. A same-length edit, or an
   edit to a file outside that list, produced an identical signature, so the
   dedupe treated it as "nothing changed" and skipped the rerun.

**Fix pattern (frontend-only, no backend change):**
- Always dispatch the run CustomEvent on any agent result, coalesced via a
  module-level debounce (~600ms) so a burst of file-apply batches collapses into
  one restart. Carry `force:true` in the event detail.
- `projectSignature` now fingerprints **every** file (`path:contentLength`), not a
  fixed key-file list.
- A `force` flag bypasses the signature dedupe **but NOT** the
  `projectNeedsDevServer` / gitBinding gate.

**Why:** owner wants zero-click live preview; reruns were being silently skipped.

**How to apply / invariant to preserve:** when touching /code preview auto-run,
keep "force bypasses *dedupe* only, never the dev-server gate" — otherwise a
static `index.html`-only workspace would spuriously spin up a Node dev server.
Also keep the install-in-flight queue (`pendingAutoRunRef`): if phase is
`starting`, defer and preserve the force flag, then drain after the runner
settles so the preview lands on the newest code. Clear the force flag on the
non-runnable early-return so it can't leak into a later run. The manual
▶ Ejecutar button stays as a fallback.
