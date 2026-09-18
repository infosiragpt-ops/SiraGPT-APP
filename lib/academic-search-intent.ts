const SOURCE_PATTERN = /\b(?:openalex|crossref|pubmed|europe\s*pmc|scielo|redalyc|semantic\s+scholar|web\s+of\s+science|scopus|doaj|arxiv|bioarxiv|biorxiv|medrxiv|dblp|datacite|core)\b/i
const IDENTIFIER_PATTERN = /\bdoi\b|10\.\d{4,9}\/[\w.()/:;-]+/i
const RESEARCH_PATTERN = /\b(?:cientific[oa]s?|acad[eé]mic[oa]s?|bibliogr[aá]fic[oa]s?|literatura\s+cient[ií]fica|evidencia\s+cient[ií]fica|peer[- ]reviewed)\b/i
const REVIEW_PATTERN = /\b(?:estado\s+del\s+arte|revisi[oó]n\s+(?:sistem[aá]tica|de\s+literatura|bibliogr[aá]fica)|meta[- ]?an[aá]lisis|systematic\s+review|literature\s+review|meta[- ]?analysis)\b/i
// Nouns that only exist in the academic world: enough on their own with a
// search verb ("busca papers sobre…", "necesito tesis sobre…").
const PUBLICATION_PATTERN = /\b(?:art[ií]culos?|papers?|publicaciones?|tesis|preprints?|datasets?)\b/i
// Everyday nouns that ALSO appear in ordinary requests ("dame cifras con
// fuentes", "los documentos de la reunión", "un estudio de mercado"). They
// only mean academic search next to an academic qualifier.
const WEAK_PUBLICATION_PATTERN = /\b(?:estudios?|investigaciones?|fuentes|referencias|documentos?)\b/i
const ACADEMIC_QUALIFIER_PATTERN = /\b(?:cient[ií]fic[oa]s?|acad[eé]mic[oa]s?|arbitrad[oa]s?|revisad[oa]s?\s+por\s+pares|indexad[oa]s?|bibliogr[aá]fic[oa]s?|peer[- ]reviewed|scholarly)\b/i
const SEARCH_ACTION_PATTERN = /\b(?:busca|buscar|b[uú]scame|encuentra|encontrar|localiza|localizar|rastrea|rastrear|consulta|consultar|necesito|quiero|dame|muestra|recopila|recopilar|selecciona|seleccionar|find|search|locate|retrieve|show|give)\b/i
const DISCOVERY_ACTION_PATTERN = /\b(?:busca|buscar|b[uú]scame|encuentra|encontrar|localiza|localizar|rastrea|rastrear|consulta|consultar|dame|muestra|recopila|recopilar|selecciona|seleccionar|find|search|locate|retrieve|show|give)\b/i
// Live-data / news questions ("precio del bitcoin hoy", "qué pasó esta
// semana") are web-search turns for the agent (RLCD × Jev decides the
// source), never a batch over academic indexes — unless the user explicitly
// names an index, a DOI or scientific literature.
const CURRENT_EVENTS_PATTERN = /\b(?:hoy|ahora\s+mismo|actualidad|actuales?|actualmente|esta\s+(?:semana|ma[ñn]ana|tarde|noche)|este\s+(?:mes|a[ñn]o)|[uú]ltim[ao]s?\s+(?:noticias?|horas|d[ií]as|semanas?|meses)|noticias?|precio|precios|cotizaci[oó]n|tiempo\s+real|en\s+vivo|resultado\s+del\s+partido|today|right\s+now|this\s+week|latest|breaking|price|prices)\b/i

export function isAcademicResearchPrompt(value: string): boolean {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  if (!text) return false
  // Explicit academic signals always win, even for live topics.
  if (SOURCE_PATTERN.test(text) || IDENTIFIER_PATTERN.test(text)) return true
  if (REVIEW_PATTERN.test(text)) return true
  if (RESEARCH_PATTERN.test(text) && DISCOVERY_ACTION_PATTERN.test(text)) return true
  // Live-data / news questions belong to the agent's web search.
  if (CURRENT_EVENTS_PATTERN.test(text)) return false
  if (!SEARCH_ACTION_PATTERN.test(text)) return false
  if (PUBLICATION_PATTERN.test(text)) return true
  return WEAK_PUBLICATION_PATTERN.test(text) && ACADEMIC_QUALIFIER_PATTERN.test(text)
}

type CustomGptRoutingContext = {
  id?: string | null
  capabilities?: {
    agentMode?: string | null
  } | null
} | null | undefined

export function shouldUseDedicatedAcademicSearch(
  value: string,
  options: {
    attachmentCount?: number
    customGptId?: string | null
    customGpt?: CustomGptRoutingContext
  } = {},
): boolean {
  if (Math.max(0, Number(options.attachmentCount) || 0) > 0) return false

  const customGpt = options.customGpt
  const customGptId = String(options.customGptId || customGpt?.id || "").trim()
  if (customGptId) {
    return false
  }

  return isAcademicResearchPrompt(value)
}

export const ACADEMIC_SEARCH_PATTERNS = {
  source: SOURCE_PATTERN,
  identifier: IDENTIFIER_PATTERN,
  research: RESEARCH_PATTERN,
  review: REVIEW_PATTERN,
  publication: PUBLICATION_PATTERN,
  weakPublication: WEAK_PUBLICATION_PATTERN,
  academicQualifier: ACADEMIC_QUALIFIER_PATTERN,
  currentEvents: CURRENT_EVENTS_PATTERN,
  action: SEARCH_ACTION_PATTERN,
}

/** FE-061: never send the raw academic query (PII) to analytics. */
export function analyticsSafeAcademicQuery(value: string): { kind: "academic"; length: number; flagged: boolean } {
  const text = String(value || "")
  return {
    kind: "academic",
    length: text.length,
    flagged: isAcademicResearchPrompt(text),
  }
}
