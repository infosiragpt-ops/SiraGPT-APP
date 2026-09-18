'use strict';

/**
 * RLCD × Jev — grounded-answer check (fase 2c).
 *
 * After a grounded turn (retrieved evidence, attached files, web results)
 * Jev judges the final answer against the sources: is it supported, does
 * it assert things the sources do not contain, does it cite sources that
 * are not there. The verdict feeds the ledger (`high_faithfulness` /
 * `low_faithfulness`, source `jev_faithfulness`) and routing feedback; when
 * the answer is confidently unsupported and the heuristic gate did not
 * already annotate, a short footer warns the user. Fail-open.
 */

const typesafe = require('../providers/typesafe');
const config = require('./config');

const MAX_ANSWER_CHARS = 6000;
const MAX_SOURCE_CHARS = 14000;

function isFaithfulnessEnabled(env = process.env) {
  const c = config.describe(env);
  return c.flags.jev.value && c.flags.jevFaithfulness.value;
}

function buildQuestions() {
  return {
    supported: {
      type: 'noul',
      instructions: '¿Las afirmaciones principales de la respuesta están respaldadas por las fuentes proporcionadas?',
      criteria: {
        true: 'Cada dato, cifra o conclusión relevante aparece en las fuentes o se deduce directamente de ellas',
        false: 'Hay afirmaciones importantes que las fuentes no contienen o que las contradicen',
      },
    },
    invented_citation: {
      type: 'noul',
      instructions: '¿La respuesta cita o atribuye algo (fuente, autor, cifra, fecha) que no existe en las fuentes proporcionadas?',
      criteria: {
        true: 'Cita fuentes, autores, títulos o datos que no aparecen en el material',
        false: 'Todas las citas y atribuciones se corresponden con el material',
      },
    },
    coverage: {
      type: 'score',
      instructions: '¿Qué parte de la respuesta se apoya en las fuentes frente a conocimiento general del modelo?',
      criteria: ['Casi nada: la respuesta ignora las fuentes', 'Parcial: mezcla fuentes con conocimiento no verificable', 'Alta: la respuesta se construye sobre las fuentes'],
    },
  };
}

function trimSources(sources) {
  const out = [];
  let budget = MAX_SOURCE_CHARS;
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || typeof s.text !== 'string' || !s.text.trim()) continue;
    if (budget <= 0) break;
    const text = s.text.replace(/\s+/g, ' ').trim().slice(0, Math.min(budget, 6000));
    out.push({ tipo: String(s.kind || 'source'), texto: text });
    budget -= text.length;
  }
  return out;
}

/**
 * @returns {Promise<null|{supported:number, invented:number, coverage:number|null, verdict:'high'|'low'|'unclear', outcome:string|null, footer:string|null, model:string, latencyMs:number}>}
 */
async function checkAnswer({ question, answer, sources = [], language = 'es', env = process.env, fetchImpl, timeoutMs } = {}) {
  const text = String(answer || '').trim();
  const src = trimSources(sources);
  if (!text || text.length < 120 || !src.length || !isFaithfulnessEnabled(env)) return null;
  const c = config.describe(env);
  try {
    const res = await typesafe.evaluate({
      state: {
        pregunta: String(question || '').slice(0, 2000),
        respuesta: text.slice(0, MAX_ANSWER_CHARS),
        fuentes: src,
      },
      questions: buildQuestions(),
      model: c.jev.model,
      env,
      fetchImpl,
      timeoutMs: Number.isFinite(timeoutMs) ? Number(timeoutMs) : Math.max(c.jev.timeoutMs, 4000),
      retries: 0,
    });
    const sup = typesafe.summarizeAnswer(res.answers.supported);
    const inv = typesafe.summarizeAnswer(res.answers.invented_citation);
    const cov = typesafe.summarizeAnswer(res.answers.coverage);
    if (!sup) return null;
    const supported = sup.value;
    const invented = inv ? inv.value : 0;
    let verdict = 'unclear';
    if (supported >= c.thresholds.jevFaithHigh.value && invented <= 1 - c.thresholds.jevFaithHigh.value) verdict = 'high';
    else if (supported <= c.thresholds.jevFaithLow.value || invented >= c.thresholds.jevFaithHigh.value) verdict = 'low';
    const outcome = verdict === 'high' ? 'high_faithfulness' : verdict === 'low' ? 'low_faithfulness' : null;
    let footer = null;
    if (verdict === 'low') {
      footer = String(language || 'es').toLowerCase().startsWith('en')
        ? '\n\n> ⚠️ Grounding check: parts of this answer are not supported by the provided sources. Verify the key claims before relying on them.'
        : '\n\n> ⚠️ Comprobación de fuentes: parte de esta respuesta no está respaldada por las fuentes disponibles. Verifica los datos clave antes de usarlos.';
    }
    return { supported, invented, coverage: cov ? cov.normalized : null, verdict, outcome, footer, model: res.model, latencyMs: res.latencyMs };
  } catch (err) {
    console.warn(`[rlcd/jev-faith] ${err && (err.code || err.message)}`);
    return null;
  }
}

module.exports = { MAX_ANSWER_CHARS, MAX_SOURCE_CHARS, isFaithfulnessEnabled, buildQuestions, trimSources, checkAnswer };
