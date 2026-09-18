'use strict';

/**
 * RLCD × Jev — RAG relevance filter (fase 2c).
 *
 * The evidence runtime retrieves the top-k chunks by vector/BM25 similarity;
 * similar is not the same as useful. One Jev fan-out scores every chunk
 * against the question (Score: irrelevante / relacionado / esencial) and
 * the block is re-rendered with irrelevant chunks dropped and the rest
 * ordered by expected usefulness. Fewer tokens, less noise, and the model
 * sees the essential passage first. Always keeps at least `minKeep` hits.
 * Recorded as kind `rag_filter`; fail-open (returns null → untouched).
 */

const typesafe = require('../providers/typesafe');
const config = require('./config');

const MAX_HITS = 16;
const CHUNK_CHARS = 900;
const LEVELS = Object.freeze([
  'Irrelevante: no ayuda a responder la pregunta',
  'Relacionado: aporta contexto o un detalle secundario',
  'Esencial: contiene información necesaria para responder',
]);

function isRagFilterEnabled(env = process.env) {
  const c = config.describe(env);
  return c.flags.jev.value && c.flags.jevRagFilter.value;
}

function buildQuestions(hits) {
  const q = {};
  hits.forEach((_, i) => {
    q[`s${i + 1}`] = {
      type: 'score',
      instructions: `¿Cuánto ayuda el fragmento S${i + 1} a responder la pregunta?`,
      criteria: [...LEVELS],
    };
  });
  return q;
}

function buildState({ query, hits }) {
  return {
    pregunta: String(query || '').slice(0, 2000),
    fragmentos: hits.map((h, i) => ({
      id: `S${i + 1}`,
      titulo: String(h.title || h.source || '').slice(0, 120),
      texto: String(h.text || '').replace(/\s+/g, ' ').trim().slice(0, CHUNK_CHARS),
    })),
  };
}

/**
 * @returns {Promise<null|{hits:object[], dropped:number, scores:number[], decisionId:string|null, latencyMs:number}>}
 */
async function filterHits({ query, hits = [], chatId = null, minKeep = 2, env = process.env, fetchImpl, ledger = null, timeoutMs } = {}) {
  if (!Array.isArray(hits) || hits.length < 3 || !isRagFilterEnabled(env)) return null;
  const c = config.describe(env);
  const subset = hits.slice(0, MAX_HITS);
  try {
    const res = await typesafe.evaluate({
      state: buildState({ query, hits: subset }),
      questions: buildQuestions(subset),
      model: c.jev.model,
      env,
      fetchImpl,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : c.jev.timeoutMs,
      retries: 0,
    });
    const scored = subset.map((hit, i) => {
      const a = typesafe.summarizeAnswer(res.answers[`s${i + 1}`]);
      const pIrrelevant = a ? Number(a.probabilities['0']) || 0 : 0;
      const expected = a && a.normalized != null ? a.normalized : 0.5;
      return { hit, i, expected, pIrrelevant, confidence: a ? a.confidence : 0 };
    });
    const dropThreshold = c.thresholds.jevRagDrop.value;
    let kept = scored.filter((s) => s.pIrrelevant < dropThreshold);
    if (kept.length < Math.min(minKeep, scored.length)) {
      kept = [...scored].sort((a, b) => a.pIrrelevant - b.pIrrelevant).slice(0, Math.min(minKeep, scored.length));
    }
    kept.sort((a, b) => b.expected - a.expected || a.i - b.i);
    const dropped = scored.length - kept.length;
    const outHits = [...kept.map((s) => s.hit), ...hits.slice(MAX_HITS)];
    let decisionId = null;
    if (ledger && typeof ledger.recordDecision === 'function') {
      const meanConf = scored.length ? scored.reduce((acc, s) => acc + s.confidence, 0) / scored.length : 0;
      decisionId = ledger.recordDecision({
        kind: 'rag_filter',
        choice: dropped > 0 ? `drop:${dropped}` : 'keep_all',
        confidence: Math.max(0, Math.min(1, meanConf)),
        chatId,
        meta: { source: 'jev', hits: scored.length, dropped, model: res.model, latencyMs: res.latencyMs },
      });
      if (chatId && decisionId && typeof ledger.appendTurn === 'function') ledger.appendTurn(chatId, [decisionId]);
    }
    return { hits: outHits, dropped, scores: scored.map((s) => Math.round(s.expected * 1000) / 1000), decisionId, latencyMs: res.latencyMs };
  } catch (err) {
    console.warn(`[rlcd/jev-rag] ${err && (err.code || err.message)}`);
    return null;
  }
}

module.exports = { MAX_HITS, LEVELS, isRagFilterEnabled, buildQuestions, buildState, filterHits };
