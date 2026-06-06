'use strict';

/**
 * siraGPT Builder · question-generator.
 *
 * Produces the next intake question for a missing coverage dimension. When the
 * free LLM tier is available it asks for a *contextual* QuestionCard — one that
 * builds on what the user already answered (the "seguimiento" the product wants)
 * — then strictly validates it against QuestionCardSchema. On any miss (no LLM,
 * bad JSON, wrong dimension, schema failure) it returns the deterministic card
 * from the static bank, so behaviour is always well-defined and tests need no
 * network.
 */

const { COVERAGE_DIMENSIONS, QuestionCardSchema } = require('./contracts');
const { questionForDimension } = require('./questions');
const defaultLlm = require('./llm');

const VALID_TYPES = ['chips', 'select', 'multiselect', 'text'];

const DIMENSION_GUIDE = {
  purpose: 'el propósito / problema que resuelve el proyecto',
  platform: 'la plataforma destino — debe ofrecer opciones web, mobile, desktop, landing',
  coreFeatures: 'las funcionalidades clave imprescindibles',
  dataEntities: 'las entidades de datos principales (ej. Usuario, Pedido)',
  style: 'el estilo / identidad visual buscada',
  audience: 'la audiencia o usuario objetivo',
};

/** Compact human summary of what the user has answered so far (for context). */
function summariseAnswers(session) {
  const answers = (session && session.answers) || {};
  const parts = [];
  for (const dim of COVERAGE_DIMENSIONS) {
    const v = answers[dim];
    if (v == null) continue;
    const text = Array.isArray(v) ? v.join(', ') : String(v);
    if (text.trim()) parts.push(`- ${dim}: ${text.trim()}`);
  }
  return parts.length ? parts.join('\n') : '(aún sin respuestas)';
}

function buildPrompt(session, dimension) {
  const fallback = questionForDimension(dimension);
  const system =
    'Eres un entrevistador experto de producto para un generador de apps full-stack. ' +
    'Tu trabajo es hacer UNA sola próxima pregunta, en español, breve y conversacional, ' +
    'que recoja el contexto ya dado y profundice en la dimensión pedida. ' +
    'Responde EXCLUSIVAMENTE con un objeto JSON válido (sin texto extra, sin markdown) ' +
    'con esta forma exacta: ' +
    '{"id":string,"dimension":string,"prompt":string,"type":"chips"|"select"|"multiselect"|"text",' +
    '"options":string[],"allowFreeText":boolean}.';
  const user =
    `Dimensión objetivo: "${dimension}" — ${DIMENSION_GUIDE[dimension]}.\n` +
    `Contexto ya recogido:\n${summariseAnswers(session)}\n\n` +
    `Reglas:\n` +
    `- "dimension" DEBE ser exactamente "${dimension}".\n` +
    `- Usa "type" "${fallback.type}" salvo que otro encaje mejor.\n` +
    `- "options": 0-6 opciones cortas (vacío para preguntas abiertas de texto).\n` +
    `- Para platform, incluye al menos web, mobile, desktop.\n` +
    `- La pregunta debe sonar a seguimiento natural de lo ya dicho.`;
  return { system, user };
}

/** Coerce arbitrary LLM JSON into a QuestionCard-shaped object. */
function coerceCard(raw, dimension) {
  const fallback = questionForDimension(dimension);
  if (!raw || typeof raw !== 'object') return null;

  const type = VALID_TYPES.includes(raw.type) ? raw.type : fallback.type;
  const options = Array.isArray(raw.options)
    ? raw.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 8)
    : [];
  const prompt = typeof raw.prompt === 'string' && raw.prompt.trim() ? raw.prompt.trim() : '';
  if (!prompt) return null;

  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `${fallback.id}-dyn`,
    dimension, // always forced to the requested dimension
    prompt,
    type,
    options,
    allowFreeText: typeof raw.allowFreeText === 'boolean' ? raw.allowFreeText : true,
  };
}

/**
 * The next QuestionCard for `dimension`. Dynamic (LLM) when available and valid;
 * otherwise the static-bank card. Never throws for a known dimension.
 * @param {object} session
 * @param {string} dimension — one of COVERAGE_DIMENSIONS
 * @param {{ llm?: object, env?: object }} [opts]
 * @returns {Promise<object>} a card satisfying QuestionCardSchema
 */
async function generateNextQuestion(session, dimension, opts = {}) {
  if (!COVERAGE_DIMENSIONS.includes(dimension)) {
    throw new Error(`question-generator: unknown dimension "${dimension}"`);
  }
  const fallback = () => questionForDimension(dimension);
  const llm = opts.llm || defaultLlm;

  if (!llm.isLlmAvailable || !llm.isLlmAvailable(opts)) return fallback();

  let json;
  try {
    const { system, user } = buildPrompt(session, dimension);
    json = await llm.completeJson({ system, user, env: opts.env });
  } catch {
    return fallback();
  }

  const card = coerceCard(json, dimension);
  if (!card) return fallback();

  const parsed = QuestionCardSchema.safeParse(card);
  if (!parsed.success || parsed.data.dimension !== dimension) return fallback();
  return parsed.data;
}

module.exports = { generateNextQuestion, coerceCard, summariseAnswers, buildPrompt };
