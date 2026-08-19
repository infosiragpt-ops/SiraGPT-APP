// Prompt + JSON schema for per-section content generation.
//
// Kept separate from the LLM call site so prompt iteration doesn't
// touch the orchestration logic. The schema is enforced server-side
// via response_format json_schema, so a malformed model reply gets
// rejected by the SDK before it can corrupt a section.
//
// IMPORTANT: This is now wired into BOTH slide (PPTX) AND document
// (DOCX/PDF/HTML/MD) renderers. The schema and prompt are tuned for
// document-style depth (4-6 sentences per section paragraph, 4-6
// substantive bullets, 2-3 sentence amplification in notes) — slides
// truncate gracefully when they receive more content than they can
// fit, but documents look amateur with the older slide-sized blocks.

const SECTION_CONTENT_SCHEMA = {
  name: 'section_content',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      paragraph: {
        type: 'string',
        description:
          'Opening prose for the section: 4 to 6 complete sentences, 80 to 160 words. Specific to the user request, concrete, no filler, no meta-commentary, no headings, no markdown, no lists inside.',
      },
      bullets: {
        type: 'array',
        minItems: 4,
        maxItems: 6,
        items: { type: 'string', minLength: 30 },
        description:
          'Substantive bullet points expanding the section: each one a complete sentence, 15-40 words, factual or actionable. Never start with "This section" or repeat the paragraph.',
      },
      notes: {
        type: 'string',
        description:
          'Amplification block of 2-3 sentences (60-140 words) adding context, caveats, methodology, or implementation detail the body did not cover. Not a summary of the bullets.',
      },
    },
    required: ['paragraph', 'bullets', 'notes'],
  },
};

function buildSystemPrompt({ language = 'es', template = 'premium' } = {}) {
  const tone = {
    academic: 'tono académico riguroso, definiciones precisas, evidencia citada de forma implícita, marcos teóricos cuando aplique',
    business: 'tono ejecutivo conciso, foco en impacto cuantificado, métricas y decisiones accionables',
    legal: 'tono formal jurídico, terminología técnica correcta, referencias normativas implícitas, sin opiniones personales',
    education: 'tono didáctico claro, ejemplos concretos progresivos, definiciones operativas, lenguaje accesible sin perder rigor',
    premium: 'tono profesional pulido, claridad ejecutiva, registro neutro elevado',
  }[template] || 'tono profesional pulido';

  if (language === 'en') {
    return [
      'You write substantive content for a specific section of a professional document (Word/PDF). The output is consumed verbatim — there is no editor between you and the final file.',
      `Tone: ${tone}.`,
      'Write with depth and specificity. Address the actual user request and the actual section name — not the topic in the abstract. Use concrete nouns, numbers, frameworks, and examples.',
      'Hard bans: "this section covers", "this section discusses", "various aspects", "it is important to note", "in conclusion", "as we have seen", "delve into", "leverage", "robust", "comprehensive", "navigate the complexities", and any sentence that could appear unchanged in a different document on a different topic.',
      'Each bullet must be self-contained — a fact, a recommendation, a metric, or a step. Not a label. Not a category. Not a question.',
      'Notes must add information the paragraph and bullets did not include (methodology, edge cases, dependencies, references, risks). Never restate the bullets.',
      'No markdown syntax inside any field (no #, *, _, -, >, backticks, links). No emojis. No preamble. Output strictly the JSON schema.',
    ].join(' ');
  }
  return [
    'Redactas contenido sustantivo para una sección específica de un documento profesional (Word/PDF). El texto se inserta verbatim en el archivo final — no hay editor entre tú y el documento.',
    `Tono: ${tone}.`,
    'Escribe con profundidad y especificidad. Aborda la solicitud real del usuario y el nombre real de la sección — no el tema en abstracto. Usa sustantivos concretos, cifras, marcos, ejemplos.',
    'Frases prohibidas: "esta sección cubre", "esta sección trata", "diversos aspectos", "es importante destacar", "en conclusión", "como hemos visto", "profundizar", "aprovechar", "robusto", "integral", "navegar la complejidad", y cualquier oración que pudiera aparecer sin cambios en un documento distinto sobre un tema distinto.',
    'Cada bullet debe ser auto-contenido — un hecho, una recomendación, una métrica o un paso. No una etiqueta. No una categoría. No una pregunta.',
    'Las notas deben aportar información que el párrafo y los bullets NO incluyeron (metodología, casos extremos, dependencias, referencias, riesgos). Nunca reformulen los bullets.',
    'Sin sintaxis markdown dentro de los campos (nada de #, *, _, -, >, backticks, links). Sin emojis. Sin preámbulo. Devuelve estrictamente el JSON del schema.',
  ].join(' ');
}

function buildUserPrompt({ userRequest, documentTitle, sectionName, language = 'es', targetWords = null }) {
  // Explicit user length constraints override the schema's default
  // 80-160-word guidance — "en 200 palabras" must produce ~200 words total,
  // not 160 words times eight sections.
  const lengthLineEn = targetWords
    ? `Length constraint: the paragraph must be about ${targetWords} words (hard requirement from the user). ${targetWords < 80 ? 'Skip optional detail; 2-3 tight sentences. Keep bullets to 3 short items.' : ''}`
    : null;
  const lengthLineEs = targetWords
    ? `Restricción de extensión: el párrafo debe rondar las ${targetWords} palabras (requisito explícito del usuario). ${targetWords < 80 ? 'Omite detalle opcional; 2-3 frases precisas. Máximo 3 bullets cortos.' : ''}`
    : null;
  if (language === 'en') {
    return [
      `User request: ${userRequest}`,
      `Document title: ${documentTitle}`,
      `Section to write: ${sectionName}`,
      lengthLineEn,
      'Write the JSON now. Treat the section name literally — if it is "Risks", write actual risks specific to the user request, not generic risk-management theory. If it is "Methodology", describe the actual steps that would apply to this request, not a textbook list of methods.',
    ].filter(Boolean).join('\n');
  }
  return [
    `Solicitud del usuario: ${userRequest}`,
    `Título del documento: ${documentTitle}`,
    `Sección a redactar: ${sectionName}`,
    lengthLineEs,
    'Redacta el JSON ahora. Trata el nombre de la sección de forma literal — si es "Riesgos", escribe riesgos reales específicos a la solicitud del usuario, no teoría genérica de gestión de riesgos. Si es "Metodología", describe los pasos reales aplicables a esta solicitud, no una lista de manual.',
  ].filter(Boolean).join('\n');
}

module.exports = { SECTION_CONTENT_SCHEMA, buildSystemPrompt, buildUserPrompt };
