export type ResearchResultSource = {
  id?: string
  source?: string | null
  sources?: string[] | null
  title?: string | null
  abstract?: string | null
  authors?: Array<{ name?: string | null } | string> | null
  year?: number | null
  journal?: string | null
  venue?: string | null
  doi?: string | null
  url?: string | null
  htmlUrl?: string | null
  pdfUrl?: string | null
  citations?: number | null
  citationCount?: number | null
  openAccess?: boolean | null
  rerankScore?: number | null
  retrievalScore?: number | null
  qualityScore?: number | null
  doiStatus?: string | null
  doiResolutionStatus?: string | null
  publicationStage?: string | null
  peerReviewStatus?: string | null
  studyType?: string | null
  integrityStatus?: string | null
  integrityAlerts?: string[] | null
  sampleSize?: number | string | null
  sampleSizes?: Array<number | string> | null
  keyFinding?: string | null
  keyFindings?: Array<string | { sentence?: string | null }> | null
  evidence?: {
    topFinding?: string | null
    findings?: Array<{ sentence?: string | null }> | null
    sampleSizes?: Array<number | string> | null
  } | null
  effects?: { sampleSizes?: Array<number | string> | null } | null
  screening?: { decision?: string; reasons?: string[]; stage?: string } | null
  riskOfBias?: { level?: string; basis?: string; recommendedTool?: string } | null
}

export type ResearchSortMode = "relevance" | "date" | "citations" | "evidence" | "access"

export type ResearchResultFilters = {
  yearFrom: number | null
  yearTo: number | null
  openAccess: "all" | "yes" | "no"
  peerReviewed: "all" | "yes" | "no"
  studyType: string
  provider: string
}

export const DEFAULT_RESEARCH_FILTERS: ResearchResultFilters = {
  yearFrom: null,
  yearTo: null,
  openAccess: "all",
  peerReviewed: "all",
  studyType: "all",
  provider: "all",
}

export function researchSourceIdentity(source: ResearchResultSource, index = 0) {
  const doi = String(source.doi || "").trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")
  if (doi) return `doi:${doi}`
  const title = String(source.title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
  return title ? `title:${title}|${Number(source.year) || ""}` : `row:${index}`
}

export function researchCitationCount(source: ResearchResultSource) {
  return Math.max(0, Number(source.citations ?? source.citationCount) || 0)
}

export function researchEvidenceScore(source: ResearchResultSource) {
  const study = String(source.studyType || "").toLowerCase()
  const design = /meta|systematic/.test(study) ? 5
    : /random|\brct\b/.test(study) ? 4
      : /cohort/.test(study) ? 3
        : /case.control/.test(study) ? 2
          : 1
  const peer = ["confirmed", "likely_peer_reviewed"].includes(String(source.peerReviewStatus || "")) ? 2 : 0
  const integrity = ["retracted", "withdrawn"].includes(String(source.integrityStatus || "")) ? -10
    : source.integrityStatus === "expression_of_concern" ? -4 : 1
  return design + peer + integrity + (Number(source.qualityScore) || 0)
}

export function researchSampleSize(source: ResearchResultSource) {
  const values = [
    source.sampleSize,
    ...(Array.isArray(source.sampleSizes) ? source.sampleSizes : []),
    ...(Array.isArray(source.effects?.sampleSizes) ? source.effects.sampleSizes : []),
    ...(Array.isArray(source.evidence?.sampleSizes) ? source.evidence.sampleSizes : []),
  ].map((value) => String(value ?? "").trim()).filter(Boolean)
  if (values.length) return Array.from(new Set(values)).slice(0, 3).map((value) => /^n\s*=/i.test(value) ? value : `n=${value}`).join(", ")
  const matches = Array.from(String(source.abstract || "").matchAll(/\b(?:n\s*=\s*|sample(?: size)? of |muestra de )(\d{1,7})\b/gi))
    .map((match) => match[1])
  return matches.length ? Array.from(new Set(matches)).slice(0, 3).map((value) => `n=${value}`).join(", ") : null
}

export function researchKeyFinding(source: ResearchResultSource) {
  const structured = [
    source.keyFinding,
    ...(Array.isArray(source.keyFindings) ? source.keyFindings.map((finding) => typeof finding === "string" ? finding : finding?.sentence) : []),
    source.evidence?.topFinding,
    ...(Array.isArray(source.evidence?.findings) ? source.evidence.findings.map((finding) => finding?.sentence) : []),
  ].map((value) => String(value || "").trim()).find(Boolean)
  if (structured) return structured
  const sentences = String(source.abstract || "").match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []
  return sentences.map((sentence) => sentence.trim()).find((sentence) => /\b(result|results|finding|findings|we found|showed|demonstrat|significant|associated|resultado|resultados|hallazgo|hallazgos|demostr|significativ|asociad)\b/i.test(sentence)) || null
}

function sourceProviders(source: ResearchResultSource) {
  return Array.from(new Set([
    source.source,
    ...(Array.isArray(source.sources) ? source.sources : []),
  ].map((provider) => String(provider || "").trim().toLowerCase()).filter(Boolean)))
}

export function applyResearchResultFilters(sources: ResearchResultSource[], filters: ResearchResultFilters) {
  return (Array.isArray(sources) ? sources : []).filter((source) => {
    const year = Number(source.year) || null
    if (filters.yearFrom && (!year || year < filters.yearFrom)) return false
    if (filters.yearTo && (!year || year > filters.yearTo)) return false
    if (filters.openAccess === "yes" && source.openAccess !== true) return false
    if (filters.openAccess === "no" && source.openAccess === true) return false
    const peerReviewed = ["confirmed", "likely_peer_reviewed"].includes(String(source.peerReviewStatus || ""))
    if (filters.peerReviewed === "yes" && !peerReviewed) return false
    if (filters.peerReviewed === "no" && peerReviewed) return false
    if (filters.studyType !== "all" && String(source.studyType || "").toLowerCase() !== filters.studyType) return false
    if (filters.provider !== "all" && !sourceProviders(source).includes(filters.provider)) return false
    return true
  })
}

export function sortResearchResults(sources: ResearchResultSource[], mode: ResearchSortMode) {
  return sources.map((source, index) => ({ source, index })).sort((left, right) => {
    if (mode === "date") return (Number(right.source.year) || 0) - (Number(left.source.year) || 0) || left.index - right.index
    if (mode === "citations") return researchCitationCount(right.source) - researchCitationCount(left.source) || left.index - right.index
    if (mode === "evidence") return researchEvidenceScore(right.source) - researchEvidenceScore(left.source) || left.index - right.index
    if (mode === "access") {
      const accessScore = (source: ResearchResultSource) => (source.openAccess === true ? 2 : 0) + (source.pdfUrl ? 1 : 0)
      return accessScore(right.source) - accessScore(left.source) || left.index - right.index
    }
    const relevance = (source: ResearchResultSource) => Number(source.rerankScore ?? source.retrievalScore ?? source.qualityScore) || 0
    return relevance(right.source) - relevance(left.source) || left.index - right.index
  }).map(({ source }) => source)
}

export function buildResearchFollowUpPrompt(query: string, sources: ResearchResultSource[]) {
  const selected = sources.slice(0, 8)
  const lines = selected.map((source, index) => {
    const doi = String(source.doi || "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    const meta = [source.year || null, source.studyType || null, doi ? `DOI ${doi}` : null].filter(Boolean).join(" · ")
    return `${index + 1}. ${source.title || "Fuente sin título"}${meta ? ` (${meta})` : ""}`
  })
  return [
    "Responde mi pregunta de seguimiento usando como contexto principal las fuentes seleccionadas, sin repetir la búsqueda completa.",
    query ? `Consulta original: ${query}` : "",
    "Fuentes seleccionadas:",
    ...lines,
    "",
    "Pregunta de seguimiento: ",
  ].filter((line) => line !== "").join("\n")
}

export const RESEARCH_FOLLOW_UP_EVENT = "siragpt:research-follow-up"

export function dispatchResearchFollowUp(query: string, sources: ResearchResultSource[]) {
  if (typeof document === "undefined") return
  document.dispatchEvent(new CustomEvent(RESEARCH_FOLLOW_UP_EVENT, {
    detail: { prompt: buildResearchFollowUpPrompt(query, sources) },
  }))
}

type ResearchCommandChat = { id?: string | null; title?: string | null; model?: string | null }

export async function ensureResearchCommandChat(options: {
  currentChat?: ResearchCommandChat | null
  query: string
  model: string
  createChat: (data: { title: string; model: string }) => Promise<any>
  addMessage: (chatId: string, data: { role: string; content: string }) => Promise<any>
}) {
  let chat = options.currentChat
  if (!chat?.id) {
    const created = await options.createChat({
      title: `Investigación: ${options.query.slice(0, 60)}`,
      model: options.model,
    })
    chat = created?.chat || created
  }
  if (!chat?.id) throw new Error("No se pudo crear la conversación de investigación")
  await options.addMessage(chat.id, { role: "USER", content: options.query })
  return chat as ResearchCommandChat & { id: string }
}

export function buildScientificPapersMessage(payload: unknown) {
  return `\`\`\`scientific-papers\n${JSON.stringify(payload)}\n\`\`\``
}
