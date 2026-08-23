# LOADERS CELESTE v2 — Pensando

Professional thinking states for `/chat` (DeepSeek). Every in-progress
state shares the **same** bouncing bars so a phase change only swaps the
top icon + Spanish label.

## Kit (19 SVGs in `public/loaders/`)

| File | Label |
|---|---|
| `pensando.svg` | Pensando… — **bars only**, `viewBox="0 0 64 64"` |
| `pensando-original.svg` | Luis original crop — `viewBox="10 40 45 50"`, bars at `y=50` |
| `buscando-internet.svg` | Buscando en internet… — magnifying glass, stroke `#38BDF8` |
| `generando-codigo.svg` | Generando código… — `</>` chevrons |
| `generando-word.svg` | Generando documento Word… — rounded rect + white W |
| `generando-pdf.svg` | Generando PDF… — similar seal |
| `generando-ppt.svg` | Generando presentación… — similar seal |
| `generando-excel.svg` | Generando hoja de cálculo… — similar seal |
| `generando-imagen.svg` | Generando imagen… |
| `generando-audio.svg` | Generando audio… |
| `generando-video.svg` | Generando video… |
| `analizando-archivo.svg` | Analizando archivo… |
| `subiendo-archivo.svg` | Subiendo archivo… |
| `descargando-archivo.svg` | Descargando archivo… |
| `enviando-correo.svg` | Enviando correo… |
| `procesando-datos.svg` | Procesando datos… |
| `cargando-general.svg` | Cargando… |
| `completado.svg` | ¡Listo! — animated check, **no bars** |
| `error.svg` | Ocurrió un error — animated X, **no bars** |

Static copies (no SMIL) live in `public/loaders/icons/` for
`prefers-reduced-motion`.

Regenerate: `node scripts/generate-celeste-loaders.cjs`

## Animation contract

Shared bounce (every file except `completado` / `error` / the original crop):

```svg
<rect x="20" y="32" width="4" height="10" fill="#38BDF8">
  <animateTransform attributeType="xml" attributeName="transform" type="translate" values="0 0; 0 20; 0 0" begin="0" dur="0.6s" repeatCount="indefinite"/>
</rect>
<!-- same at x=30 begin=0.2s and x=40 begin=0.4s -->
```

- Color: brand celeste `#38BDF8` (`--sira-celeste` / `--step-running`)
- Top static icon stays above `y≈24`; dots sit at `y=32`
- `prefers-reduced-motion: reduce` swaps in the static icon copy

## Tool → state (LEEME)

| Signal | State |
|---|---|
| `web_search`, `deep_search`, `read_url`, `scientific_search`, `github_search`, “Buscando…” | `buscando-internet` |
| `docintel*`, `rag_retrieve`, `read_file`, “Analizando archivo” | `analizando-archivo` |
| `create_docx`, `*.docx`, “documento Word” | `generando-word` |
| `pdf`, `*.pdf` | `generando-pdf` |
| `presentation`, `*.pptx` | `generando-ppt` |
| `spreadsheet`, `*.xlsx` | `generando-excel` |
| `write_file`, `edit_file`, `execute_python`, `execute_bash` | `generando-codigo` |
| `generate_image`, `create_chart`, visual tools | `generando-imagen` |
| `generate_speech`, `generate_music` | `generando-audio` |
| `generate_video` | `generando-video` |
| `upload*`, ingest | `subiendo-archivo` |
| `download*` | `descargando-archivo` |
| `send_email`, `gmail` | `enviando-correo` |
| `python_exec`, `code_sandbox` | `procesando-datos` |
| run `completed` / `succeeded` | `completado` (brief flash, then collapse) |
| run `error` / `failed` | `error` |
| default | `pensando` |

Implementation: `lib/thinking-loaders.ts` (`mapEventToLoaderState`,
`mapToolToLoaderState`). Step identity prefers `step_id` (RunTrace PR 393).

## UI wiring

- `ThinkingStatusLoader` — **status chip** (kit SVG + Spanish label + elapsed)
- `ClaudeThinkingTimeline` header, `AgenticSteps` live header, inherited by
  ThinkingPlaceholder / ThinkingTrace / AgentTrace
- RunTrace (PR 393): this chip is the header; the **step list stays
  semantic** (`--step-running` blue, `--step-failed` red only — never brand-red)

`/code` Ejecutar / Arrancando is **not** this surface. Do not reuse these
loaders on the preview-pane run button.

## Tests

`tests/thinking-loader-map.test.ts`
