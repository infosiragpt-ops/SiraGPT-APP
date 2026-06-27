---
name: /code builder auto-apply + thinking glyph
description: The /code agent applies generated code itself (no manual buttons) in write modes; ask/plan/image stay read-only. Canonical thinking SVG.
---

The /code builder is a real agentic coding system: in WRITE modes it applies
generated file blocks automatically and opens the live preview — there are NO
manual "Aplicar"/"Aplicar todo y ver" buttons (the owner rejected them).

Write modes that auto-apply: app, build, debug, patch. Read-only modes
(ask, plan, image) MUST pass autoApply:false and never write files — this is a
hard contract; auto-apply is gated on composerMode and ask/plan/image also
short-circuit before the engine/patch routing.

**Why:** Jorge asked the agentic system to do the writing instead of clicking
"Aplicar" per block. But ask/plan are explainer/read-only surfaces and must
never silently mutate the workspace.

**How to apply:** Keep "Copiar"/"Ver diff" for transparency. If auto-apply
throws, surface it (toast.error + mark the "apply" phase error) — there is no
manual button to fall back on. The canonical "pensando" SVG across the whole
product is DotmCircular15 from `@/components/ui/dotm-circular-15` (color
`THINKING_GLYPH_COLOR`); do not reintroduce the old ThinkingIndicator in /code.
