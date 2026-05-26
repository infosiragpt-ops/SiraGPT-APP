export type SearchBrainResultLite = {
  sourceProvider: string
  category: string
  title: string
  url?: string
  datePublished?: string
  author?: string
  metadata?: Record<string, any>
}

export function categoryActionLabel(category: string) {
  if (category === "shopping") return "Ver oferta"
  if (category === "jobs") return "Aplicar"
  if (category === "academic") return "Abrir paper"
  if (category === "news") return "Leer noticia"
  return "Abrir"
}

export function formatYear(value: string) {
  const year = new Date(value).getUTCFullYear()
  return Number.isFinite(year) ? String(year) : value
}

export function buildApa(item: SearchBrainResultLite) {
  const year = item.metadata?.year || (item.datePublished ? formatYear(item.datePublished) : "s. f.")
  const author = item.author || "Autor desconocido"
  const venue = item.metadata?.venue || item.metadata?.journal || item.sourceProvider
  const doi = item.metadata?.doi ? ` https://doi.org/${item.metadata.doi}` : item.url ? ` ${item.url}` : ""
  return `${author} (${year}). ${item.title}. ${venue}.${doi}`
}

export function buildSynthesis(query: string, results: SearchBrainResultLite[], llmReranked = false) {
  if (!query.trim()) return "La síntesis aparecerá aquí con citas numeradas cuando ejecutes una búsqueda."
  if (results.length === 0) return "Sin resultados todavía. UniversalSearchBrain consultará proveedores activos y mostrará trazabilidad por fuente."
  const top = results.slice(0, 3).map((r, i) => `[${i + 1}] ${r.title}`).join("; ")
  const mode = llmReranked ? "Síntesis con reranking LLM" : "Síntesis heurística auditada"
  return `${mode}: para “${query}”, las fuentes mejor puntuadas son ${top}. Usa los enlaces numerados para auditar cada resultado.`
}
