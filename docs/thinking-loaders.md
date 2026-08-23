# LOADERS CELESTE v2 — Pensando

Professional thinking states for `/chat` (DeepSeek). Every in-progress
state shares the **same** bouncing bars so a phase change only swaps the
top icon + Spanish label — the bounce never restarts.

## Kit

| File | Label |
|---|---|
| `public/loaders/pensando.svg` | Pensando… |
| `public/loaders/buscando-internet.svg` | Buscando en internet… |
| `public/loaders/generando-codigo.svg` | Generando código… |
| `public/loaders/generando-word.svg` | Generando documento Word… |
| `public/loaders/generando-pdf.svg` | Generando PDF… |
| `public/loaders/generando-ppt.svg` | Generando presentación… |
| `public/loaders/generando-excel.svg` | Generando hoja de cálculo… |
| `public/loaders/generando-imagen.svg` | Generando imagen… |
| `public/loaders/generando-audio.svg` | Generando audio… |
| `public/loaders/generando-video.svg` | Generando video… |
| `public/loaders/analizando-archivo.svg` | Analizando archivo… |
| `public/loaders/subiendo-archivo.svg` | Subiendo archivo… |
| `public/loaders/descargando-archivo.svg` | Descargando archivo… |
| `public/loaders/enviando-correo.svg` | Enviando correo… |
| `public/loaders/procesando-datos.svg` | Procesando datos… |
| `public/loaders/cargando-general.svg` | Cargando… |
| `public/loaders/puntitos.svg` | Pensando… (bars only) |
| `public/loaders/completado.svg` | ¡Listo! (check, no bars) |
| `public/loaders/error.svg` | Ocurrió un error (X, no bars) |

Icon-only copies (no SMIL bars) live in `public/loaders/icons/` so
`ThinkingStatusLoader` can swap the glyph without remounting the bounce.

Regenerate: `node scripts/generate-celeste-loaders.cjs`

## Animation contract

- Color: brand celeste `#38BDF8` (`--sira-celeste` / `--step-running`)
- Bars: 4×10 px, rx 2
- Bounce: 20 px, `dur=0.6s`, delays `0 / 0.2 / 0.4s`
- `prefers-reduced-motion: reduce` freezes the bars

Terminal states omit the bars.

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

- `ThinkingStatusLoader` — header: icon + stable bars + label + elapsed
- `ClaudeThinkingTimeline` — one header loader; trail uses semantic
  `--step-pending / --step-running / --step-done / --step-failed`
- `AgenticStepsRenderer` live header on `/chat`
- `ThinkingPlaceholder` / `ThinkingTrace` / `AgentTrace` inherit via the timeline

`/code` Ejecutar / Arrancando is **not** this surface. Do not reuse these
loaders on the preview-pane run button.

## Tests

`tests/thinking-loader-map.test.ts`
