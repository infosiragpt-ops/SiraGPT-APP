---
name: /code agent rail merge fragility
description: The 5-step progress rail + Worked Summary live entirely in ai-code-chat-panel.tsx turn state; GitHub merges that take the origin side silently drop them.
---

The `/code` 5-step progress rail (Plan → Contexto → Generar → Aplicar → Verificar)
and the Worked Summary are NOT a self-contained component — they are driven by
per-turn state (`agentLabel` + `agentPhases` + `actions`/`metrics`) set inline
across multiple callbacks in `components/code/ai-code-chat-panel.tsx`:
`sendPrompt` (LLM), `buildApp` (deterministic app build), `runEngine` (Motor),
and the dispatch intake-`ask` path. The render only shows them via
`liveAgentLabel` + `<CodeAgentProgress phases={turn.agentPhases} />`.

**Why this is fragile:** a merge that takes the origin side of a chat-panel
conflict can drop the phase-setting AND the render in non-conflict regions while
keeping origin's other improvements (auto-boot preview, build-mode auto-apply).
The code still compiles and the app still works — the rail just silently never
renders. Typecheck will NOT catch it.

**How to apply / verify after any chat-panel merge:**
- Render block must define `liveAgentLabel = planLabel || turn.agentLabel ||
  (turn.streaming ? "Pensando" : "")` and render `<CodeAgentProgress
  phases={turn.agentPhases} />`.
- `buildApp` (PRIMARY app-build path, dispatch case "generate") must set
  generate-running phases at start, verify-done phases + `buildWriteMetrics`
  actions/metrics on success — this is where the built-app turn's Worked Summary
  comes from. Needs `startedAt` + `files` in its deps array.
- `sendPrompt` must set: plan at start, context→generate before the stream,
  verify at completion (on `base` BEFORE the `applied.length>0 || usage` metrics
  gate so text-only turns still advance), generate-error on onError + catch.
- `CodeAgentProgress` returns null when `phases` is undefined, so paths that
  skip phases degrade gracefully — no crash, just no rail.
- `runEngine` (Motor/OpenCode) drives the rail via a local `setEnginePhase()`
  helper: plan→context (after session ensured)→generate (before prompt). Its
  `finish()` helper defaults to verify-done phases and takes optional
  `{ label, phases }` so the error exit passes generate-error; apply detail is
  keyed on whether files were written.
- The intake-`ask` dispatch case sets context-running on the question turn and
  verify-done on BOTH the dynamic-question success and static-question catch.
