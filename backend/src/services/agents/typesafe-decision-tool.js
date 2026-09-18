'use strict';

/**
 * `decide_with_jev` — lets any agentic turn ask TypeSafe Jev for a calibrated
 * decision (choice / score / yes-no) about a state, instead of guessing with
 * the chat model. Never throws: returns { ok:false, code, message }.
 */

const typesafe = require('../providers/typesafe');

const decideWithJevTool = {
  name: 'decide_with_jev',
  description: [
    'Pide a TypeSafe Jev (modelo de decisiones calibradas, RLCD) que evalúe un `state` con preguntas tipadas.',
    'Úsalo para clasificar, priorizar, puntuar o decidir entre opciones con probabilidades honestas en vez de adivinar.',
    'Tipos: `noul` (sí/no → probabilidad), `choice` (elige una opción entre `criteria` {opcion: descripcion}), `score` (posición en una escala `criteria` [nivel0, nivel1, …]).',
    'Devuelve por pregunta la elección, la distribución de probabilidades y `confidence` (0–1). Con confidence < 0.5 no actúes en automático.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      state: {
        description: 'Contenido a evaluar: texto, o un objeto/array JSON con los datos relevantes (mensaje, registros, contexto).',
        anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }],
      },
      questions: {
        type: 'object',
        description: 'Mapa id → pregunta. Cada pregunta: { type: "noul"|"choice"|"score", instructions: string, criteria? }.',
        additionalProperties: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['noul', 'choice', 'score'] },
            instructions: {},
            criteria: {},
          },
          required: ['type', 'instructions'],
        },
      },
      model: { type: 'string', description: 'jev-latest (por defecto) o jev-1.13 para fijar versión.' },
    },
    required: ['state', 'questions'],
    additionalProperties: false,
  },
  execute: async (args = {}, ctx = {}) => {
    const env = (ctx && ctx.env) || process.env;
    if (!typesafe.isConfigured(env)) {
      return { ok: false, code: 'typesafe_not_configured', message: 'TypeSafe (Jev) no está configurado: añade TYPESAFE_API_KEY en Admin → Conexiones.' };
    }
    try {
      const res = await typesafe.evaluate({
        state: args.state,
        questions: args.questions,
        model: args.model || 'jev-latest',
        env,
        fetchImpl: ctx && ctx.fetchImpl,
        timeoutMs: 15000,
      });
      const answers = {};
      for (const id of Object.keys(res.answers || {})) {
        const s = typesafe.summarizeAnswer(res.answers[id]);
        answers[id] = s
          ? {
            type: s.kind,
            answer: s.kind === 'noul' ? (s.yes ? 'yes' : 'no') : s.value,
            probability: s.kind === 'noul' ? s.value : undefined,
            label: s.kind === 'score' ? s.label : undefined,
            confidence: Number(s.confidence.toFixed(3)),
            band: typesafe.confidenceBand(s.confidence),
            probabilities: s.probabilities,
          }
          : res.answers[id];
      }
      return { ok: true, model: res.model, answers, usage: res.usage, latencyMs: res.latencyMs };
    } catch (err) {
      return { ok: false, code: (err && err.code) || 'typesafe_error', message: String((err && err.message) || err) };
    }
  },
};

module.exports = { decideWithJevTool };
