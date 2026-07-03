'use strict';

const { resolveContentClient } = require('./llm-client');

const REQUEST_TIMEOUT_MS = 12_000;

// LLM intent parse for document requests — the "brain" layer. Separates the
// CORE TOPIC from delivery CONDITIONS (slide/word/page counts, courtesy,
// quality adjectives, format words) and repairs obvious typos in constraint
// words. Real failure this fixes: "crea una ppt de la gestión administrativa
// en 10 Landin porfavor de forma muy profeiosnal" produced a deck titled
// "Gestión administrativa en 10 Landin porfavor de forma muy profeiosnal"
// whose thesis hallucinated "las diez sucursales de Landin" — the typo'd
// "10 láminas" constraint was read as topic content.
const REQUEST_INTENT_SCHEMA = {
  name: 'document_request_intent',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      topic: { type: 'string', description: 'The CORE subject only, in the request language, typos repaired. No counts, no courtesy (por favor/gracias/please), no quality words (profesional/bonito), no format words (ppt/word/excel/pdf).' },
      title: { type: 'string', description: 'Professional document title derived from the topic (3-9 words, no trailing punctuation).' },
      slideCount: { type: ['integer', 'null'], description: 'Requested TOTAL number of slides if the user asked for one (e.g. "en 10 láminas/diapositivas/slides", including typos like "Landin"→"láminas"). Null when not requested.' },
      wordCount: { type: ['integer', 'null'], description: 'Requested word count ("en 200 palabras") or null.' },
      pageCount: { type: ['integer', 'null'], description: 'Requested page count ("de 2 páginas") or null.' },
      conditions: { type: 'array', items: { type: 'string' }, description: 'Other delivery conditions the user stated (tone, audience, structure requirements), each as a short phrase. Empty array if none.' },
    },
    required: ['topic', 'title', 'slideCount', 'wordCount', 'pageCount', 'conditions'],
  },
};

function normalizeIntent(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const topic = String(parsed.topic || '').trim();
  const title = String(parsed.title || '').trim().replace(/[.,;:]+$/, '');
  if (!topic || !title || title.length < 3) return null;
  const clampCount = (value, min, max) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  return {
    topic: topic.slice(0, 160),
    title: title.slice(0, 120),
    slideCount: clampCount(parsed.slideCount, 2, 40),
    wordCount: clampCount(parsed.wordCount, 50, 20000),
    pageCount: clampCount(parsed.pageCount, 1, 200),
    conditions: (Array.isArray(parsed.conditions) ? parsed.conditions : [])
      .map((c) => String(c).trim()).filter(Boolean).slice(0, 6),
  };
}

/**
 * Parse a raw document request into { topic, title, slideCount, wordCount,
 * pageCount, conditions } or null (caller keeps its deterministic parse —
 * fail-open, same doctrine as the section writer).
 */
async function parseDocumentRequest({ prompt, format = 'docx', language = 'es', signal } = {}) {
  const request = String(prompt || '').trim();
  if (!request) return null;
  const resolved = resolveContentClient();
  if (!resolved) return null;
  try {
    const completion = await resolved.client.chat.completions.create({
      model: resolved.model,
      messages: [
        {
          role: 'system',
          content: [
            'Eres el intérprete de solicitudes de documentos de una plataforma AI. Tu único trabajo: separar el TEMA CENTRAL de las CONDICIONES de entrega.',
            'Condiciones típicas que NUNCA van en el tema/título: número de láminas/diapositivas/slides, número de palabras o páginas, cortesías (por favor, porfavor, gracias, please), adjetivos de calidad (profesional, bonito, bien elaborado, executive), palabras de formato (ppt, powerpoint, word, docx, excel, pdf, documento, presentación) y verbos de pedido (crea, genera, hazme).',
            'Repara typos evidentes ANTES de interpretar: "Landin"/"landin" en contexto "en 10 …" significa "láminas"; "profeiosnal"→"profesional"; "diapositvas"→"diapositivas".',
            'Si el usuario pide un número de láminas, va en slideCount (entero), jamás en el tema.',
            'Responde SOLO el JSON del schema.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Formato solicitado: ${format}\nIdioma: ${language}\nSolicitud del usuario: ${request.slice(0, 800)}`,
        },
      ],
      response_format: { type: 'json_schema', json_schema: REQUEST_INTENT_SCHEMA },
      temperature: 0.1,
    }, { signal, timeout: REQUEST_TIMEOUT_MS });
    const raw = completion?.choices?.[0]?.message?.content;
    if (!raw) return null;
    return normalizeIntent(JSON.parse(raw));
  } catch {
    return null;
  }
}

module.exports = { parseDocumentRequest, normalizeIntent, REQUEST_INTENT_SCHEMA };
