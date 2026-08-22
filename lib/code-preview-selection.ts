export const CODE_SELECT_TARGET_EVENT = "siragpt:code-select-target"
export const CODE_SELECTION_CAPTURED_EVENT = "siragpt:code-selection-captured"
export const CODE_SELECTION_CANCEL_EVENT = "siragpt:code-selection-cancel"

export type CodePreviewSelectionRect = {
  x: number
  y: number
  width: number
  height: number
}

export type CodePreviewSelectionDetail = {
  selector?: string
  selectionMethod?: "dom" | "region"
  tagName?: string
  id?: string
  className?: string
  text?: string
  parent?: {
    selector?: string
    tagName?: string
    className?: string
    text?: string
  } | null
  role?: string
  ariaLabel?: string
  href?: string
  src?: string
  rect?: CodePreviewSelectionRect
  relativePoint?: {
    x: number
    y: number
    percentX: number
    percentY: number
  }
  pageUrl?: string
  pageTitle?: string
  previewKind?: string
  entry?: string | null
  activePath?: string | null
  activeFolderId?: string | null
  capturedAt?: string
}

export type CodePreviewSelectionCancelDetail = {
  reason?: string
  source?: "chat" | "preview"
}

function selectionValue(value: unknown, max = 240): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  if (!text) return "sin dato"
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Pull the free-form user instruction out of a previous selection prompt dump. */
export function extractInstructionFromComposer(text: string): string {
  const raw = String(text || "")
  const markers = [
    "Cambio solicitado por el usuario:\n",
    "Cambio solicitado:\n",
  ]
  for (const marker of markers) {
    const idx = raw.indexOf(marker)
    if (idx < 0) continue
    let rest = raw.slice(idx + marker.length)
    const cut = rest.search(/\n\n(?:Si la selección|Usa el selector)/)
    if (cut >= 0) rest = rest.slice(0, cut)
    return rest.replace(/^\s+|\s+$/g, "")
  }
  if (raw.includes("Modifica el elemento que acabo de seleccionar en el preview de APPS.")) {
    return ""
  }
  return raw
}

export function selectedElementChipLabel(detail: CodePreviewSelectionDetail): string {
  const selector = selectionValue(detail.selector || detail.tagName || "elemento", 72)
  const text = String(detail.text || "").replace(/\s+/g, " ").trim()
  if (!text) return selector
  const short = text.length > 36 ? `${text.slice(0, 35)}…` : text
  return `${selector} · “${short}”`
}

export function buildSelectedElementPrompt(
  detail: CodePreviewSelectionDetail,
  existingInstruction: string,
): string {
  const rect = detail.rect
    ? `${detail.rect.width}x${detail.rect.height} en x:${detail.rect.x}, y:${detail.rect.y}`
    : "sin dato"
  const point = detail.relativePoint
    ? `${detail.relativePoint.percentX}% / ${detail.relativePoint.percentY}% del preview`
    : "sin dato"
  const parent = detail.parent
    ? `${selectionValue(detail.parent.selector, 160)} · ${selectionValue(detail.parent.text, 180)}`
    : "sin dato"
  const currentInstruction = extractInstructionFromComposer(existingInstruction).trim()
  return [
    "Modifica el elemento que acabo de seleccionar en el preview de APPS.",
    "",
    "Elemento seleccionado:",
    `- método de selección: ${selectionValue(detail.selectionMethod || "dom", 80)}`,
    `- selector CSS: ${selectionValue(detail.selector)}`,
    `- etiqueta: ${selectionValue(detail.tagName, 80)}`,
    `- texto visible: ${selectionValue(detail.text)}`,
    `- contenedor padre: ${parent}`,
    `- clases: ${selectionValue(detail.className)}`,
    `- id: ${selectionValue(detail.id, 120)}`,
    `- role/aria: ${selectionValue([detail.role, detail.ariaLabel].filter(Boolean).join(" / "), 160)}`,
    `- href/src: ${selectionValue([detail.href, detail.src].filter(Boolean).join(" / "), 180)}`,
    `- caja visual: ${rect}`,
    `- punto relativo: ${point}`,
    `- preview: ${selectionValue(detail.previewKind, 80)} · ${selectionValue(detail.entry || detail.pageUrl, 180)}`,
    `- archivo activo probable: ${selectionValue(detail.activePath, 180)}`,
    "",
    currentInstruction
      ? `Cambio solicitado por el usuario:\n${currentInstruction}`
      : "Cambio solicitado:\n",
    "",
    detail.selectionMethod === "region"
      ? "Si la selección vino como región visual, usa las coordenadas, el archivo activo y el texto visible del preview para localizar el componente más probable antes de editar."
      : "Usa el selector DOM y el contenedor padre para localizar el componente correcto antes de editar.",
    "Aplica el cambio en los archivos correctos del workspace, conserva el resto del diseño y verifica que el preview siga funcionando.",
  ].join("\n")
}


/** OLA200_WAVE_F FE-052 — ignore a selection that belongs to a destroyed preview. */
export type PreviewSelectionLifetime = {
  previewId?: string | null
  generation?: number | null
  destroyed?: boolean
}

export function shouldApplyPreviewSelection(
  detail: CodePreviewSelectionDetail & PreviewSelectionLifetime,
  live: PreviewSelectionLifetime,
): boolean {
  if (detail?.destroyed || live?.destroyed) return false
  if (live?.previewId && detail?.previewId && String(live.previewId) !== String(detail.previewId)) {
    return false
  }
  if (
    Number.isFinite(Number(live?.generation))
    && Number.isFinite(Number(detail?.generation))
    && Number(live.generation) !== Number(detail.generation)
  ) {
    return false
  }
  return true
}
