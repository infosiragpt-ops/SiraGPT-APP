/**
 * LOADERS CELESTE v2 — state catalog + tool/event → loader map.
 *
 * Shared by ThinkingStatusLoader, AgenticSteps, Claude timeline, AgentTrace.
 * Pure module (no React) so node:test can cover every mapping.
 */

export const SIRA_CELESTE = "#38BDF8"

/** Runtime states wired into ThinkingStatusLoader / tool map. */
export const LOADER_STATES = [
  "pensando",
  "buscando-internet",
  "generando-codigo",
  "generando-word",
  "generando-pdf",
  "generando-ppt",
  "generando-excel",
  "generando-imagen",
  "generando-audio",
  "generando-video",
  "analizando-archivo",
  "subiendo-archivo",
  "descargando-archivo",
  "enviando-correo",
  "procesando-datos",
  "cargando-general",
  "completado",
  "error",
] as const

/** All 19 kit files under public/loaders/ (includes Luis's original crop). */
export const KIT_SVG_FILES = ["pensando-original", ...LOADER_STATES] as const

export type LoaderState = (typeof LOADER_STATES)[number]

export const LOADER_LABELS: Record<LoaderState, string> = {
  pensando: "Pensando…",
  "buscando-internet": "Buscando en internet…",
  "generando-codigo": "Generando código…",
  "generando-word": "Generando documento Word…",
  "generando-pdf": "Generando PDF…",
  "generando-ppt": "Generando presentación…",
  "generando-excel": "Generando hoja de cálculo…",
  "generando-imagen": "Generando imagen…",
  "generando-audio": "Generando audio…",
  "generando-video": "Generando video…",
  "analizando-archivo": "Analizando archivo…",
  "subiendo-archivo": "Subiendo archivo…",
  "descargando-archivo": "Descargando archivo…",
  "enviando-correo": "Enviando correo…",
  "procesando-datos": "Procesando datos…",
  "cargando-general": "Cargando…",
  completado: "¡Listo!",
  error: "Ocurrió un error",
}

export const TERMINAL_LOADER_STATES: ReadonlySet<LoaderState> = new Set(["completado", "error"])

export function isLoaderState(value: unknown): value is LoaderState {
  return typeof value === "string" && (LOADER_STATES as readonly string[]).includes(value)
}

export function isTerminalLoaderState(state: LoaderState): boolean {
  return TERMINAL_LOADER_STATES.has(state)
}

export function loaderSrc(state: LoaderState): string {
  return `/loaders/${state}.svg`
}

/** Luis's three-bar crop — the only animated in-progress glyph. */
export const PENSANDO_BARS_SRC = "/loaders/pensando.svg"
export const PENSANDO_BARS_STATIC_SRC = "/loaders/icons/pensando.svg"

/** Static (no SMIL) copy for prefers-reduced-motion. */
export function loaderIconSrc(state: LoaderState): string {
  if (isTerminalLoaderState(state)) return `/loaders/icons/${state}.svg`
  return PENSANDO_BARS_STATIC_SRC
}

/**
 * In-progress chips always use the same three celeste bars.
 * Seal / lupa / W / PDF kit files stay on disk for the catalog but are
 * never the live glyph — Spanish labels carry the phase meaning.
 * Terminal states keep the static check / X.
 */
export function loaderChipSrc(state: LoaderState): string {
  if (isTerminalLoaderState(state)) return loaderSrc(state)
  return PENSANDO_BARS_SRC
}

export function loaderLabel(state: LoaderState, override?: string | null): string {
  const explicit = String(override || "").replace(/\s+/g, " ").trim()
  if (explicit && explicit.length <= 92) return explicit
  return LOADER_LABELS[state]
}

export type LoaderEventInput = {
  tool?: string | null
  name?: string | null
  label?: string | null
  text?: string | null
  status?: string | null
  args?: unknown
  path?: string | null
  filename?: string | null
  format?: string | null
  step_id?: string | null
  stepId?: string | null
}

function blobFromArgs(args: unknown): string {
  if (!args) return ""
  if (typeof args === "string") return args
  if (typeof args !== "object") return ""
  const rec = args as Record<string, unknown>
  return [
    rec.filename,
    rec.path,
    rec.file,
    rec.format,
    rec.skill,
    rec.skillId,
    rec.query,
    rec.url,
    rec.code,
    rec.command,
  ]
    .filter((v) => v != null)
    .map((v) => String(v))
    .join(" ")
}

function haystack(input: LoaderEventInput): string {
  return [
    input.tool,
    input.name,
    input.label,
    input.text,
    input.path,
    input.filename,
    input.format,
    blobFromArgs(input.args),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[_./]+/g, " ")
}

function statusToTerminal(status?: string | null): LoaderState | null {
  const s = String(status || "").toLowerCase()
  if (!s) return null
  if (/(error|fail|denied|aborted|cancelled|canceled)/.test(s)) return "error"
  // Run-level success only — step.status === "done" is a finished hop, not ¡Listo!
  if (/(succeed|success|completed|complete|ready)/.test(s)) return "completado"
  return null
}

function fromDocumentHint(hay: string): LoaderState | null {
  if (/\bdocx?\b|documento word|archivo word|generando documento word/.test(hay)) return "generando-word"
  if (/\bpptx?\b|powerpoint|presentation|presentaci[oó]n|diapositiva/.test(hay)) return "generando-ppt"
  if (/\bxlsx?\b|spreadsheet|hoja de c[aá]lculo|excel/.test(hay)) return "generando-excel"
  if (/\bpdf\b|generando pdf/.test(hay)) return "generando-pdf"
  return null
}

/**
 * Map a tool name, stream label, or step payload to a CELESTE loader state.
 * More specific document/media hints win over generic code/data tools.
 */
export function mapEventToLoaderState(input: LoaderEventInput = {}): LoaderState {
  const terminal = statusToTerminal(input.status)
  if (terminal) return terminal

  const hay = haystack(input)

  const fromDoc = fromDocumentHint(hay)
  if (fromDoc) return fromDoc

  if (/(ocurr[ií]o un error|error al|failed|fall[oó])/.test(hay)) return "error"
  if (/(^|\b)(!?listo|completado|ready)(\b|$)/.test(hay) && /listo|completado/.test(hay)) {
    if (/¡listo|completado/.test(hay)) return "completado"
  }

  if (/(web search|web_search|brave|duckduckgo|x search|scientific search|github search|deep search|buscando en internet|buscando fuentes|buscando informaci)/.test(hay)) {
    return "buscando-internet"
  }
  if (/(generate image|generate_image|create chart|create_chart|create organigram|create mermaid|create infographic|create dashboard|create comparison|create process|create timeline|create kanban|imagen|image gen|generando imagen)/.test(hay)) {
    return "generando-imagen"
  }
  if (/(generate speech|generate_speech|generate music|generate_music|\btts\b|generando audio)/.test(hay)) {
    return "generando-audio"
  }
  if (/(generate video|generate_video|generando video)/.test(hay)) {
    return "generando-video"
  }
  if (/(docintel|analyz|analyse|rag retrieve|rag_retrieve|read file|read_file|read skill|deep document|intent analy|analizando archivo|leyendo (el )?archivo|leyendo (el )?documento)/.test(hay)) {
    return "analizando-archivo"
  }
  if (/(upload|auto.file|ingest|subiendo archivo)/.test(hay)) return "subiendo-archivo"
  if (/(download|export file|descargando archivo)/.test(hay)) return "descargando-archivo"
  if (/(gmail|send mail|send_email|send email|enviando correo|correo)/.test(hay)) return "enviando-correo"
  if (/(write file|edit file|str replace|execute python|execute bash|run javascript|type check|generando c[oó]digo|generar c[oó]digo|\bcoding\b)/.test(hay)) {
    return "generando-codigo"
  }
  if (/(python exec|python_exec|code sandbox|sandbox exec|procesando datos|code_sandbox)/.test(hay)) {
    return "procesando-datos"
  }
  if (/(cargando|loading)/.test(hay)) return "cargando-general"
  if (/(^|\b)(search|read url|read_url|web extract|browse|navigate)(\b|$)/.test(hay)) {
    return "buscando-internet"
  }
  if (/(^|\b)(python|bash|exec|lint|build)(\b|$)/.test(hay)) return "generando-codigo"

  return "pensando"
}

export function mapToolToLoaderState(tool?: string | null, extras: Omit<LoaderEventInput, "tool"> = {}): LoaderState {
  return mapEventToLoaderState({ ...extras, tool })
}

export function stepIdentity(input: LoaderEventInput): string {
  return String(input.step_id || input.stepId || input.tool || input.name || input.label || "step")
}
