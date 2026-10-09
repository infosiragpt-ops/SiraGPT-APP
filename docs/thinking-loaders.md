# LOADERS CELESTE — one glyph for every in-progress state

Professional thinking states for `/chat` (DeepSeek). **Every in-progress
state shares the same 3×3 dot-matrix ripple (dotm-3x3-15).** Phase meaning lives in
the Spanish label next to it — never in a lupa, W, PDF seal, or sunburst.

## Live glyph (authoritative)

`public/loaders/pensando.svg` and the inline `PensandoBars` component
render the shadcn `@dotmatrix/dotm-3x3-15` ripple (celeste #38BDF8):

- `viewBox="0 0 36 36"` — 9 dots, ring-staggered opacity pulse. The
  bouncing three-bar SVG is **retired** (kept as `pensando-original`).
- rects at `x=20/30/40`, `y=50`, `width=4`, `height=10`
- bounce `values="0 0; 0 20; 0 0"`, `dur="0.6s"`
- begins `0` / `0.2s` / `0.4s`
- fill `#38BDF8` (never `currentColor`)

`prefers-reduced-motion: reduce` keeps the same three bars and drops
`animateTransform`. Static copy: `public/loaders/icons/pensando.svg`.

## Labels carry meaning

| State | Label |
|---|---|
| `pensando` | Pensando… |
| `buscando-internet` | Buscando en internet… |
| `generando-codigo` | Generando código… |
| `generando-word` | Generando documento Word… |
| `generando-pdf` | Generando PDF… |
| `generando-ppt` | Generando presentación… |
| `generando-excel` | Generando hoja de cálculo… |
| `generando-imagen` | Generando imagen… |
| `generando-audio` | Generando audio… |
| `generando-video` | Generando video… |
| `analizando-archivo` | Analizando archivo… |
| `subiendo-archivo` | Subiendo archivo… |
| `descargando-archivo` | Descargando archivo… |
| `enviando-correo` | Enviando correo… |
| `procesando-datos` | Procesando datos… |
| `cargando-general` | Cargando… |
| `completado` | ¡Listo! — static check, **no bounce** |
| `error` | Ocurrió un error — static X, **no bounce** |

Seal / lupa kit files may still sit on disk under `public/loaders/` for
the catalog. They are **not** the live glyph. `loaderChipSrc()` returns
`/loaders/pensando.svg` for every non-terminal state.

## Tool → state (LEEME)

| Signal | State (label only) |
|---|---|
| `web_search`, `deep_search`, `read_url`, “Buscando…” | `buscando-internet` |
| `docintel*`, `rag_retrieve`, `read_file` | `analizando-archivo` |
| `create_docx`, `*.docx` | `generando-word` |
| `pdf`, `*.pdf` | `generando-pdf` |
| `presentation`, `*.pptx` | `generando-ppt` |
| `spreadsheet`, `*.xlsx` | `generando-excel` |
| `write_file`, `edit_file`, `execute_python` | `generando-codigo` |
| `generate_image`, visual tools | `generando-imagen` |
| run `completed` / `succeeded` | `completado` (brief flash, then collapse) |
| run `error` / `failed` | `error` |
| default | `pensando` |

Implementation: `lib/thinking-loaders.ts` (`mapEventToLoaderState`).
Step identity prefers `step_id`.

## UI wiring

- `PensandoBars` — inline SVG, fill `#38BDF8`, reduced-motion static.
- `ThinkingIndicator` — same three celeste bars on every in-progress
  process (docs, auth, PPT, buttons). Never the red circular glyph.
- `ThinkingStatusLoader` — in-progress always mounts `PensandoBars` +
  the kit Spanish label. Terminal states keep check / X.
- `ClaudeThinkingTimeline` header and `kind` `loader|sunburst` → the
  same glyph. The live Pensando glyph is the **ThinkingCore**
  (`components/brand/thinking-core.tsx` via `components/claude-asterisk.tsx`),
  drawn in the monochrome think accent: `--think-accent` is the foreground
  (black on light, white on dark — the same ink as the `SiraMark` brand logo).
  Since 2026-10-09 the ThinkingCore is the **official SiraGPT mark in motion**
  (same geometry as the `SiraMark` logo, model in `lib/brand/sira-motion.ts`):
  eight arms open and close in a continuous 1.5 s cycle (0.75 s each way) in four staggered
  ranks, the tip dots bloom once they clear the centre and the centre breathes;
  idle, the server render and reduced motion are the resting open frame — the
  static logo in ink. Monochrome: the only colour is `tone="error"` (destructive
  red). The atom of 2026-10-02, the celeste 3×3 dot matrix and the old sunburst
  are **retired** for live Pensando. Labels are muted
  neutral greys (`--think-text`, `--think-dim`). Collapsed rows read
  «Pensó durante N s · N pasos» on every flow (chat, agent loop, agentic steps).
- Live progress (stage v3): the header shows the **real current step**
  («Leyendo «contrato.pdf»», «Buscando en la web · “…”») with its own
  seconds and a one-line note; finished steps get a check and their duration.
  The rotating phrases are only the fallback for a bare «Pensando…». While
  the answer streams the trace folds into one line («Redactando la respuesta ·
  420 palabras»).
- `ThinkingTrace` / `AgentTrace` / `ThinkingPlaceholder` emit
  `kind: "loader"` + `loaderState`. They never force `kind: "sunburst"`.
- RunTrace live header uses the **real step label** when the step carries
  one (the step then leaves the rail list, so the copy is never repeated);
  a bare «Pensando» keeps the kit label (`Generando presentación…` /
  `Pensando…`).
- English tool tokens (`create presentation · render preview`) are
  mapped to Spanish via `humanizeToolDetail`.
- `/chat` assistant thinking surfaces use `ThinkingStatusLoader`.
  Compact process chips (`LongOperationIndicator`, AgentStatus
  `thinking`) render the same bars. Button busy states may still use
  `ThinkingIndicator` (not a Pensando row).

`/code` Ejecutar / Arrancando is **not** this surface.

## Tests

- `tests/thinking-loader-map.test.ts` — chip path is always
  `/loaders/pensando.svg` while in progress; `pensando.svg` matches
  the y=50 contract
- `tests/thinking-loader-live-source.test.ts` — live path mounts
  `PensandoBars`; no sunburst; no per-tool seal glyph
- `tests/run-trace-reducer.test.ts` — Spanish humanization of tool
  tokens
