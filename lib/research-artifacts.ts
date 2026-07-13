import type { ResearchResultSource } from "@/lib/research-results"

export const RESEARCH_ARTIFACT_EVENT = "siragpt:research-artifact"

export type ResearchArtifactFormat = "docx" | "pptx"

export type ResearchArtifactRequest = {
  query: string
  title: string
  format: ResearchArtifactFormat
  slideCount?: number
  outline: string[]
  sources: ResearchResultSource[]
}

export const DEFAULT_RESEARCH_DOCX_OUTLINE = [
  "Resumen ejecutivo",
  "Pregunta y alcance",
  "Método de búsqueda",
  "Síntesis de la evidencia",
  "Limitaciones",
  "Conclusiones y recomendaciones",
]

export const DEFAULT_RESEARCH_PPTX_OUTLINE = [
  "Pregunta y contexto",
  "Cómo se obtuvo la evidencia",
  "Hallazgos principales",
  "Implicancias prácticas",
  "Conclusiones y próximos pasos",
]

export function researchArtifactContentSlides(totalSlides: number, hasSources = true) {
  const total = Math.max(2, Math.min(40, Math.round(Number(totalSlides) || 8)))
  const shell = 1 + (total >= 5 ? 1 : 0) + (hasSources && total >= 7 ? 1 : 0)
  return Math.max(1, total - shell)
}

export function fitResearchOutline(outline: string[], target: number) {
  const defaults = DEFAULT_RESEARCH_PPTX_OUTLINE
  const clean = Array.from(new Set((Array.isArray(outline) ? outline : [])
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter((item) => item.length >= 3)))
  const next = clean.slice(0, target)
  let index = 0
  while (next.length < target) {
    const candidate = defaults[index] || `Sección ${next.length + 1}`
    if (!next.includes(candidate)) next.push(candidate)
    index += 1
  }
  return next
}

export function buildResearchArtifactPrompt(request: ResearchArtifactRequest) {
  const title = request.title.trim() || `Síntesis científica: ${request.query}`
  const outline = request.outline.map((item, index) => `${index + 1}. ${item}`).join("\n")
  if (request.format === "pptx") {
    return [
      `Crea una presentación PowerPoint editable titulada "${title}" con exactamente ${request.slideCount || 8} diapositivas en total.`,
      `Consulta científica original: ${request.query}`,
      "Respeta este esquema aprobado y su orden:",
      outline,
      "Sintetiza la evidencia seleccionada sin inventar resultados. Incluye citas [S#] visibles y procedencia en gráficos y cifras.",
    ].join("\n")
  }
  return [
    `Crea un documento Word editable titulado "${title}".`,
    `Consulta científica original: ${request.query}`,
    "Respeta este esquema aprobado y su orden:",
    outline,
    "Incluye una matriz de evidencia editable, citas [S#], DOI y limitaciones de la evidencia.",
  ].join("\n")
}

export function dispatchResearchArtifact(request: ResearchArtifactRequest) {
  if (typeof document === "undefined") return
  document.dispatchEvent(new CustomEvent<ResearchArtifactRequest>(RESEARCH_ARTIFACT_EVENT, { detail: request }))
}
