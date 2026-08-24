# LOADERS CELESTE — one glyph for every in-progress state

Professional thinking states for `/chat` (DeepSeek). **Every in-progress
state shares the same bouncing three-bar SVG.** Phase meaning lives in
the Spanish label next to it — never in a lupa, W, PDF seal, or sunburst.

## Live glyph (authoritative)

`public/loaders/pensando.svg` and the inline `PensandoBars` component
render Luis's exact geometry:

- `viewBox="10 40 45 50"`
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
  same bars. The Claude sunburst is **retired** for live Pensando.
- `ThinkingTrace` / `AgentTrace` / `ThinkingPlaceholder` emit
  `kind: "loader"` + `loaderState`. They never force `kind: "sunburst"`.
- RunTrace live header uses the **kit label** (`Generando presentación…`
  / `Pensando…`), not the active step string, so the header and the
  step list never repeat the same copy.
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
