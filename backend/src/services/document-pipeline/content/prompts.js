// Prompt + JSON schema for per-section content generation.
//
// Kept separate from the LLM call site so prompt iteration doesn't
// touch the orchestration logic. The schema is enforced server-side
// via response_format json_schema, so a malformed model reply gets
// rejected by the SDK before it can corrupt a slide.

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
          '2 to 3 sentence opening for this section. Specific to the user request, no filler, no meta-commentary.',
      },
      bullets: {
        type: 'array',
        minItems: 3,
        maxItems: 5,
        items: { type: 'string' },
        description: 'Concrete, factual bullet points. Each one fits in a single line on a slide.',
      },
      notes: {
        type: 'string',
        description: 'One or two sentences of speaker notes. Not a repeat of the bullets.',
      },
    },
    required: ['paragraph', 'bullets', 'notes'],
  },
};

function buildSystemPrompt({ language = 'es', template = 'premium' } = {}) {
  const tone = {
    academic: 'tono académico riguroso, citas implícitas, definiciones claras',
    business: 'tono ejecutivo conciso, foco en impacto y métricas',
    legal: 'tono formal jurídico, términos precisos',
    education: 'tono didáctico claro, ejemplos concretos',
    premium: 'tono profesional pulido, claridad ejecutiva',
  }[template] || 'tono profesional pulido';

  if (language === 'en') {
    return [
      'You generate slide content for a specific section of a presentation.',
      `Tone: ${tone}.`,
      'Write substantive, on-topic content. Never use placeholder phrases like "this section covers", "content goes here", "various aspects".',
      'Bullets must be self-contained facts or recommendations, not labels.',
      'Speaker notes must add detail the slide does not show, not repeat bullets.',
      'Output strictly the JSON schema. No markdown, no preamble.',
    ].join(' ');
  }
  return [
    'Generas contenido de slide para una sección específica de una presentación.',
    `Tono: ${tone}.`,
    'Escribe contenido sustantivo y específico al tema. Jamás uses frases vacías tipo "esta sección cubre", "contenido aquí", "diversos aspectos".',
    'Cada bullet debe ser un hecho o recomendación auto-contenido, no una etiqueta.',
    'Las notas del presentador agregan detalle que el slide no muestra, no repiten los bullets.',
    'Devuelve estrictamente el JSON del schema. Sin markdown, sin preámbulo.',
  ].join(' ');
}

function buildUserPrompt({ userRequest, documentTitle, sectionName, language = 'es' }) {
  if (language === 'en') {
    return [
      `User request: ${userRequest}`,
      `Presentation title: ${documentTitle}`,
      `Section to write: ${sectionName}`,
      'Generate the JSON for this section now.',
    ].join('\n');
  }
  return [
    `Solicitud del usuario: ${userRequest}`,
    `Título de la presentación: ${documentTitle}`,
    `Sección a redactar: ${sectionName}`,
    'Genera el JSON para esta sección ahora.',
  ].join('\n');
}

module.exports = { SECTION_CONTENT_SCHEMA, buildSystemPrompt, buildUserPrompt };
