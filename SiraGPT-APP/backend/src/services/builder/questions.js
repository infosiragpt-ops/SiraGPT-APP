'use strict';

/**
 * siraGPT Builder · E1 — question bank.
 *
 * One canonical QuestionCard per coverage dimension. The intake engine asks
 * these, in COVERAGE_DIMENSIONS order, for whatever dimension is still missing.
 * Every card here is validated against QuestionCardSchema at module load, so a
 * malformed card fails fast rather than at request time.
 */

const { COVERAGE_DIMENSIONS, QuestionCardSchema } = require('./contracts');

/** @type {Record<string, import('zod').infer<typeof QuestionCardSchema>>} */
const QUESTION_BANK = {
  purpose: {
    id: 'q-purpose',
    dimension: 'purpose',
    prompt: '¿Cuál es el propósito principal de tu proyecto? Cuéntame qué problema resuelve.',
    type: 'text',
    options: [],
    allowFreeText: true,
  },
  platform: {
    id: 'q-platform',
    dimension: 'platform',
    prompt: '¿En qué plataforma quieres construirlo?',
    type: 'chips',
    options: ['web', 'mobile', 'desktop', 'landing'],
    allowFreeText: false,
  },
  coreFeatures: {
    id: 'q-core-features',
    dimension: 'coreFeatures',
    prompt: '¿Cuáles son las funcionalidades clave que no pueden faltar?',
    type: 'multiselect',
    options: ['autenticación', 'pagos', 'panel de control', 'búsqueda', 'notificaciones', 'chat'],
    allowFreeText: true,
  },
  dataEntities: {
    id: 'q-data-entities',
    dimension: 'dataEntities',
    prompt: '¿Qué datos manejará? Nombra las entidades principales (ej. Usuario, Pedido, Producto).',
    type: 'text',
    options: [],
    allowFreeText: true,
  },
  style: {
    id: 'q-style',
    dimension: 'style',
    prompt: '¿Qué estilo visual buscas?',
    type: 'chips',
    options: ['minimalista', 'corporativo', 'colorido', 'oscuro', 'moderno'],
    allowFreeText: true,
  },
  audience: {
    id: 'q-audience',
    dimension: 'audience',
    prompt: '¿Quién es tu audiencia o usuario objetivo?',
    type: 'text',
    options: [],
    allowFreeText: true,
  },
};

// Fail fast: every card must satisfy the contract and every dimension must have one.
for (const dimension of COVERAGE_DIMENSIONS) {
  const card = QUESTION_BANK[dimension];
  if (!card) throw new Error(`questions: missing QuestionCard for dimension "${dimension}"`);
  const parsed = QuestionCardSchema.safeParse(card);
  if (!parsed.success) {
    throw new Error(`questions: invalid QuestionCard for "${dimension}": ${parsed.error.message}`);
  }
}

/**
 * Returns the canonical QuestionCard for a coverage dimension.
 * @param {string} dimension
 * @returns {object} a frozen copy of the card
 */
function questionForDimension(dimension) {
  const card = QUESTION_BANK[dimension];
  if (!card) throw new Error(`questions: unknown dimension "${dimension}"`);
  return { ...card, options: [...card.options] };
}

module.exports = { QUESTION_BANK, questionForDimension };
