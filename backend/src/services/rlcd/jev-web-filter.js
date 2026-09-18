'use strict';

/**
 * RLCD × Jev — web search result filter (fase 3, búsquedas web).
 *
 * Search providers rank by lexical/PageRank-ish similarity; Jev scores every
 * hit against the actual question (Irrelevante / Relacionado / Esencial) in
 * ONE fan-out and the tool returns the essential hits first with the noise
 * dropped. The model reads fewer, better sources and cites the right URL.
 * Always keeps at least `minKeep` hits. Recorded as kind `web_search_filter`;
 * fail-open (returns null → results untouched).
 */

const typesafe = require('../providers/typesafe');
const config = require('./config');

const MAX_HITS = 12;
const SNIPPET_CHARS = 500;
const LEVELS = Object.freeze([
  'Irrelevante: no trata de lo que pregunta el usuario o es spam/SEO sin contenido',
  'Relacionado: toca el tema pero solo aporta contexto o un detalle parcial',
  'Esencial: responde directamente o es la fuente que habría que citar',
]);

function isWebFilterEnabled(env = process.env) {
  const c = config.describe(env);
  return c.flags.jev.value && c.flags.jevWebFilter.value;
}

function buildQuestions(results) {
  const q = {};
  results.forEach((_, i) => {
    q[`r${i + 1}`] = {
      type: 'score',
      instructions: `¿Cuánto sirve el resultado R${i + 1} para responder la pregunta del usuario?`,
      criteria: [...LEVELS],
    };
  });
  return q;
}

function buildState({ query, results }) {
  return {
    pregunta: String(query || '').slice(0, 1500),
    resultados: results.map((r, i) => ({
      id: `R${i + 1}`,
      titulo: String(r.title || '').slice(0, 200),
      url: String(r.url || '').slice(0, 300),
      fragmento: String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
      fuente: String(r.source || '').slice(0, 40),
    })),
  };
}

/**
 * @returns {Promise<null|{results:object[], dropped:number, scores:number[], decisionId:string|null, latencyMs:number}>}
 */
async function filterResults({ query, results = [], chatId = null, minKeep = 2, env = process.env, fetchImpl, ledger = null, timeoutMs } = {}) {
  if (!Array.isArray(results) || results.length < 3 || !isWebFilterEnabled(env)) return null;
  const c = config.describe(env);
  const subset = results.slice(0, MAX_HITS);
  try {
    const res = await typesafe.evaluate({
      state: buildState({ query, results: subset }),
      questions: buildQuestions(subset),
      model: c.jev.model,
      env,
      fetchImpl,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : c.jev.timeoutMs,
      retries: 0,
    });
    const scored = subset.map((hit, i) => {
      const a = typesafe.summarizeAnswer(res.answers[`r${i + 1}`]);
      const pIrrelevant = a ? Number(a.probabilities['0']) || 0 : 0;
      const expected = a && a.normalized != null ? a.normalized : 0.5;
      return { hit, i, expected, pIrrelevant, confidence: a ? a.confidence : 0 };
    });
    const dropThreshold = c.thresholds.jevWebDrop.value;
    let kept = scored.filter((s) => s.pIrrelevant < dropThreshold);
    if (kept.length < Math.min(minKeep, scored.length)) {
      kept = [...scored].sort((a, b) => a.pIrrelevant - b.pIrrelevant).slice(0, Math.min(minKeep, scored.length));
    }
    kept.sort((a, b) => b.expected - a.expected || a.i - b.i);
    const dropped = scored.length - kept.length;
    const out = [...kept.map((s) => ({ ...s.hit, jevRelevance: Math.round(s.expected * 100) / 100 })), ...results.slice(MAX_HITS)];
    let decisionId = null;
    if (ledger && typeof ledger.recordDecision === 'function') {
      const meanConf = scored.length ? scored.reduce((acc, s) => acc + s.confidence, 0) / scored.length : 0;
      decisionId = ledger.recordDecision({
        kind: 'web_search_filter',
        choice: dropped > 0 ? `drop:${dropped}` : 'keep_all',
        confidence: Math.max(0, Math.min(1, meanConf)),
        chatId,
        meta: { source: 'jev', hits: scored.length, dropped, model: res.model, latencyMs: res.latencyMs },
      });
      if (chatId && decisionId && typeof ledger.appendTurn === 'function') ledger.appendTurn(chatId, [decisionId]);
    }
    return { results: out, dropped, scores: scored.map((s) => Math.round(s.expected * 1000) / 1000), decisionId, latencyMs: res.latencyMs };
  } catch (err) {
    console.warn(`[rlcd/jev-web] ${err && (err.code || err.message)}`);
    return null;
  }
}

module.exports = { MAX_HITS, LEVELS, isWebFilterEnabled, buildQuestions, buildState, filterResults };
