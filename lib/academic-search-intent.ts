const SOURCE_PATTERN = /\b(?:openalex|crossref|pubmed|europe\s*pmc|scielo|redalyc|semantic\s+scholar|web\s+of\s+science|scopus|doaj|arxiv|bioarxiv|biorxiv|medrxiv|dblp|datacite|core)\b/i
const IDENTIFIER_PATTERN = /\bdoi\b|10\.\d{4,9}\/[\w.()/:;-]+/i
const RESEARCH_PATTERN = /\b(?:cientific[oa]s?|acad[eé]mic[oa]s?|bibliogr[aá]fic[oa]s?|literatura\s+cient[ií]fica|evidencia\s+cient[ií]fica|peer[- ]reviewed)\b/i
const REVIEW_PATTERN = /\b(?:estado\s+del\s+arte|revisi[oó]n\s+(?:sistem[aá]tica|de\s+literatura|bibliogr[aá]fica)|meta[- ]?an[aá]lisis|systematic\s+review|literature\s+review|meta[- ]?analysis)\b/i
const PUBLICATION_PATTERN = /\b(?:art[ií]culos?|papers?|publicaciones?|estudios?|investigaciones?|fuentes|referencias|tesis|preprints?|datasets?|documentos?)\b/i
const SEARCH_ACTION_PATTERN = /\b(?:busca|buscar|b[uú]scame|encuentra|encontrar|localiza|localizar|rastrea|rastrear|consulta|consultar|necesito|quiero|dame|muestra|recopila|recopilar|selecciona|seleccionar|find|search|locate|retrieve|show|give)\b/i
const DISCOVERY_ACTION_PATTERN = /\b(?:busca|buscar|b[uú]scame|encuentra|encontrar|localiza|localizar|rastrea|rastrear|consulta|consultar|dame|muestra|recopila|recopilar|selecciona|seleccionar|find|search|locate|retrieve|show|give)\b/i

export function isAcademicResearchPrompt(value: string): boolean {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  if (!text) return false
  if (SOURCE_PATTERN.test(text) || IDENTIFIER_PATTERN.test(text)) return true
  if (REVIEW_PATTERN.test(text)) return true
  if (RESEARCH_PATTERN.test(text) && DISCOVERY_ACTION_PATTERN.test(text)) return true
  return PUBLICATION_PATTERN.test(text) && SEARCH_ACTION_PATTERN.test(text)
}

export const ACADEMIC_SEARCH_PATTERNS = {
  source: SOURCE_PATTERN,
  identifier: IDENTIFIER_PATTERN,
  research: RESEARCH_PATTERN,
  review: REVIEW_PATTERN,
  publication: PUBLICATION_PATTERN,
  action: SEARCH_ACTION_PATTERN,
}
