'use strict';

/**
 * memory-llm-extract — LLM-assisted durable-fact extraction.
 *
 * The regex extractor (memory-intelligence) only catches a fixed set of
 * phrasings. This catches ANY way a user states something worth remembering
 * ("el año pasado me mudé a Barcelona", "yo suelo trabajar de noche") using a
 * cheap/fast model (Cerebras llama-3.1-8b via builder/llm).
 *
 * Fail-open: returns [] when no model is configured (CEREBRAS_API_KEY unset),
 * on timeout, network error, or junk output. Designed to run FIRE-AND-FORGET
 * after the response so it never adds latency to a chat turn — the facts it
 * finds are stored for FUTURE recall.
 *
 * Pure-ish & injectable: `completeJsonFn` is a parameter so it's unit-testable
 * without any network/key.
 */

const { completeJson, isLlmAvailable } = require('./builder/llm');

const VALID_CATEGORIES = new Set(['identity', 'preference', 'project', 'instruction', 'general']);

const SYSTEM_PROMPT = [
  'Eres un extractor de memoria de largo plazo para un asistente de IA.',
  'Del MENSAJE del usuario, extrae SOLO hechos personales DURABLES que valga la pena recordar para futuras conversaciones:',
  'identidad (nombre, rol, ubicación), preferencias (gustos/disgustos, herramientas que usa), proyecto en el que trabaja, o instrucciones permanentes que pide recordar.',
  'NO extraigas: peticiones de tareas, preguntas, código, datos efímeros, ni nada que no sea un dato estable sobre el usuario.',
  'Cada "fact" debe ser una afirmación breve en tercera persona ("El usuario ...", "Prefiere ...").',
  'Responde SOLO con JSON válido con esta forma exacta:',
  '{"facts":[{"fact":"...","category":"identity|preference|project|instruction","confidence":0.0}]}',
  'Si no hay nada duradero que recordar, responde {"facts":[]}.',
].join('\n');

function normalizeFact(f) {
  if (!f || typeof f.fact !== 'string') return null;
  const fact = f.fact.trim().replace(/\s+/g, ' ').slice(0, 200);
  if (fact.length < 2) return null;
  const category = VALID_CATEGORIES.has(f.category) ? f.category : 'general';
  let confidence = typeof f.confidence === 'number' ? f.confidence : 0.7;
  if (!Number.isFinite(confidence)) confidence = 0.7;
  confidence = Math.max(0, Math.min(1, confidence));
  return { fact, category, confidence, attribute: null, polarity: 'positive' };
}

/**
 * @returns {Promise<Array<{fact,category,confidence,attribute,polarity}>>}
 */
async function extractFacts(message, opts = {}) {
  const text = String(message || '').trim();
  if (!text || text.length < 4) return [];
  const completeJsonFn = typeof opts.completeJsonFn === 'function' ? opts.completeJsonFn : completeJson;
  let out;
  try {
    out = await completeJsonFn({
      system: SYSTEM_PROMPT,
      user: text.slice(0, 4000),
      temperature: 0.1,
      maxTokens: 400,
      timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 8000,
    });
  } catch {
    return [];
  }
  if (!out || !Array.isArray(out.facts)) return [];
  const seen = new Set();
  const facts = [];
  for (const raw of out.facts) {
    const f = normalizeFact(raw);
    if (!f) continue;
    const key = f.fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(f);
    if (facts.length >= 5) break;
  }
  return facts;
}

/** Cheap gate so callers skip the work entirely when no model is configured. */
function available(env = process.env) {
  try {
    return isLlmAvailable({ env });
  } catch {
    return false;
  }
}

module.exports = { extractFacts, available, normalizeFact, SYSTEM_PROMPT, VALID_CATEGORIES };
