/**
 * Frontend mirror of backend/src/services/agents/software-build-intent.js.
 * Keep the regexes in lockstep: website/app/software asks must not fall
 * through to the Document Sandbox Word path.
 */

function normalize(value: string): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const CREATE_RE = /\b(crea(?:r|me)?|haz(?:me)?|genera(?:r|me)?|desarrolla(?:r|me)?|programa(?:r|me)?|construye(?:r|me)?|implementa(?:r|me)?|disena(?:r|me)?|maqueta(?:r|me)?|arma(?:r|me)?|build|make|develop|quiero|necesito)\b/

const SOFTWARE_NOUN_RE = /\b(sitio web|pagina web|website|webpage|landing page|landing|web app|aplicacion web|aplicacion|ecommerce|e-commerce|tienda online|saas|software|app|(?:una|un|mi)\s+web|web\s+(?:de|para|app|con)|pagina(?:\s+(?:de|para))\s+\w+)\b/

const OFFICE_FORMAT_RE = /\b(word|docx|pdf|excel|xlsx|pptx?|powerpoint|power\s*point)\b/

const DOCUMENT_NOUN_RE = /\b(informe|ensayo|reporte|tesis|monografia|brochure|folleto|propuesta|contrato|manual|documento|presentacion|diapositivas?|copy)\b/

const COPY_OR_DATA_RE = /\b(datos de ventas|copy de ventas|analisis de ventas|tabla de ventas|cifras de ventas|copy\b.{0,40}\bbrochure|copy\b.{0,40}\bfolleto)\b/

const DIAGRAM_RE = /\b(diagrama|mermaid|organigrama|grafico|grafica|chart|uml|swot|foda|mapa mental)\b/

const STACK_DELIVERABLE_RE = /\b(app web|web app|sitio web|pagina web|landing|e-?commerce|tienda online)\b/
const STACK_HINT_RE = /\b(next\.?js|react|tailwind|html|css|javascript|typescript|vite)\b/

export function isCopyOrDataAsk(text: string): boolean {
  return COPY_OR_DATA_RE.test(normalize(text))
}

export function isExplicitDocumentRequest(text: string): boolean {
  const n = normalize(text)
  if (!n) return false
  if (/\b(?:en|como|a|formato)\s+(?:un\s+|una\s+|el\s+|la\s+)?(?:word|docx|pdf|excel|xlsx|pptx?|powerpoint|documento\s+word)\b/.test(n)) {
    return true
  }
  if (OFFICE_FORMAT_RE.test(n) && (CREATE_RE.test(n) || DOCUMENT_NOUN_RE.test(n))) {
    return true
  }
  const creation = CREATE_RE.exec(n)
  if (creation) {
    // Ignore source references before the ask, and compare requested objects.
    const requested = n.slice(creation.index + creation[0].length)
    const documentIndex = requested.search(DOCUMENT_NOUN_RE)
    if (documentIndex >= 0) {
      const softwareIndex = requested.search(SOFTWARE_NOUN_RE)
      return softwareIndex < 0 || documentIndex < softwareIndex
    }
  }
  return false
}

export function isSoftwareBuildRequest(text: string): boolean {
  const n = normalize(text)
  if (!n) return false
  if (isCopyOrDataAsk(n)) return false
  if (DIAGRAM_RE.test(n)) return false
  if (isExplicitDocumentRequest(n)) return false
  if (CREATE_RE.test(n) && SOFTWARE_NOUN_RE.test(n)) return true
  return STACK_DELIVERABLE_RE.test(n) && STACK_HINT_RE.test(n)
}
