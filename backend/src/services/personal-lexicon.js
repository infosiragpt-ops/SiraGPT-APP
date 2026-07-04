'use strict';

/**
 * personal-lexicon
 *
 * Aprende y resuelve términos personales del usuario que no son
 * inferibles por ningún router genérico: abreviaturas, nombres de
 * proyectos, archivos referidos coloquialmente ("mi CV", "el cliente
 * premium", "el plan Q3"). Sin esto, el usuario tiene que re-explicar
 * cada vez qué entiende por sus términos propios.
 *
 * Backend reuse:
 *   - Almacenamiento: misma capa RAG que long-term-memory.js (rag-service),
 *     pero en una collection dedicada (`lexicon:<userId>`) para no
 *     mezclarse con hechos generales.
 *   - Embeddings: vienen del mismo embedder que LTM (rag.embed).
 *
 * Entries: { term, definition, lastSeenAt, hitCount }
 *
 * API:
 *   - recordTerm({ userId, term, definition }): persist, dedupe.
 *   - lookupTerms({ userId, prompt, k }): semantic recall top-K.
 *   - decayUnused({ userId, olderThanDays }): mark stale terms.
 *   - buildLexiconBlock(terms): system-prompt block builder.
 *
 * Falla silenciosa: si RAG no está disponible o el usuario no tiene
 * lexicón, retorna [] sin ruido. Nunca bloquea.
 */

const rag = require('./rag-service');

const COLLECTION_PREFIX = 'lexicon:';
const DEFAULT_RECALL_K = 5;
const DEFAULT_RECALL_FETCH = 12;
const MAX_TERM_LEN = 120;
const MAX_DEFINITION_LEN = 400;
const DEFAULT_DECAY_DAYS = 60;

const LEXICON_DISABLED = String(process.env.SIRAGPT_LEXICON_DISABLED || '').toLowerCase() === '1';

// In-memory meta tracking (mirrors LTM's factMeta pattern). Tracks hits
// + lastSeenAt so we can de-prioritise stale terms without re-querying
// the RAG store on every recall.
const termMeta = new Map(); // userId -> Map(termHash -> { hits, lastSeenAt })

function collectionFor(userId) {
  return `${COLLECTION_PREFIX}${userId || 'anon'}`;
}

function termHash(term) {
  return String(term || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function getMeta(userId, term) {
  const inner = termMeta.get(userId);
  if (!inner) return { hits: 0, lastSeenAt: 0 };
  return inner.get(termHash(term)) || { hits: 0, lastSeenAt: 0 };
}

function bumpMeta(userId, term) {
  let inner = termMeta.get(userId);
  if (!inner) {
    inner = new Map();
    termMeta.set(userId, inner);
  }
  const key = termHash(term);
  const cur = inner.get(key) || { hits: 0, lastSeenAt: 0 };
  cur.hits += 1;
  cur.lastSeenAt = Date.now();
  inner.set(key, cur);
}

function clamp(s, max) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Format a term entry as a single RAG doc. The text format is
 * `<term> = <definition>` to maximise semantic match against future
 * mentions of the term itself.
 */
function buildDoc(term, definition) {
  return {
    text: `${term} = ${definition}`,
    title: 'lexicon',
    source: 'lex',
  };
}

/**
 * recordTerm — fire-and-forget. Errors swallowed.
 *
 * Dedupe: si el mismo `term` ya existe con la misma definición exacta,
 * skip; si tiene una definición distinta, ingestamos como entrada nueva
 * (el recall ranking decidirá cuál pesa más).
 */
// Near-duplicate guard (brain-infra roadmap #2): recording the same or a
// near-identical term used to blind-ingest a new RAG doc every time, bloating
// the collection and splitting hit counts. Identical hash → just bump meta;
// token-Jaccard > 0.8 vs an existing term → treat as the same concept.
function findNearDuplicate(userId, term) {
  const inner = termMeta.get(userId);
  if (!inner) return null;
  const hash = termHash(term);
  if (inner.has(hash)) return hash;
  const tokens = new Set(termHash(term).split(/\s+/).filter(Boolean));
  if (!tokens.size) return null;
  for (const existingHash of inner.keys()) {
    const existingTokens = new Set(existingHash.split(/\s+/).filter(Boolean));
    if (!existingTokens.size) continue;
    let intersection = 0;
    for (const tk of tokens) if (existingTokens.has(tk)) intersection += 1;
    const union = tokens.size + existingTokens.size - intersection;
    if (union > 0 && intersection / union > 0.8) return existingHash;
  }
  return null;
}

async function recordTerm({ userId, term, definition }) {
  if (LEXICON_DISABLED || !userId) return false;
  const t = clamp(term, MAX_TERM_LEN);
  const d = clamp(definition, MAX_DEFINITION_LEN);
  if (!t || !d) return false;
  try {
    const duplicateOf = findNearDuplicate(userId, t);
    if (duplicateOf) {
      // Same concept already recorded: strengthen it instead of re-ingesting.
      const inner = termMeta.get(userId);
      const meta = inner && inner.get(duplicateOf);
      if (meta) {
        meta.hits += 1;
        meta.lastSeenAt = Date.now();
      }
      return true;
    }
    const docs = [buildDoc(t, d)];
    await rag.ingest(userId, collectionFor(userId), docs, { size: 1000, overlap: 0 });
    bumpMeta(userId, t);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * recordTermsBatch — batch version. Skips empty entries.
 */
async function recordTermsBatch({ userId, entries }) {
  if (LEXICON_DISABLED || !userId || !Array.isArray(entries) || entries.length === 0) return 0;
  let ok = 0;
  for (const e of entries) {
    if (await recordTerm({ userId, term: e?.term, definition: e?.definition })) ok++;
  }
  return ok;
}

/**
 * lookupTerms — semantic recall over the user's lexicon collection.
 * Returns Array<{ term, definition, confidence, hits }>.
 */
async function lookupTerms({ userId, prompt, k = DEFAULT_RECALL_K } = {}) {
  if (LEXICON_DISABLED || !userId || !prompt) return [];
  try {
    const hits = await rag.retrieve(userId, collectionFor(userId), prompt, DEFAULT_RECALL_FETCH);
    if (!Array.isArray(hits) || hits.length === 0) return [];
    const parsed = [];
    for (const h of hits) {
      const text = String(h?.text || '').trim();
      if (!text) continue;
      const eqIdx = text.indexOf('=');
      if (eqIdx < 0) continue;
      const term = text.slice(0, eqIdx).trim();
      const definition = text.slice(eqIdx + 1).trim();
      if (!term || !definition) continue;
      const meta = getMeta(userId, term);
      const recencyBoost = meta.lastSeenAt > 0
        ? Math.max(0, 1 - (Date.now() - meta.lastSeenAt) / (DEFAULT_DECAY_DAYS * 24 * 3600 * 1000))
        : 0;
      const confidence = Math.min(1, (h.score || 0) * 0.7 + recencyBoost * 0.3);
      parsed.push({ term, definition, confidence, hits: meta.hits });
    }
    // Sort by composite confidence and cap.
    parsed.sort((a, b) => b.confidence - a.confidence);
    const top = parsed.slice(0, k);
    // Side effect: bump meta for matches above threshold (used == fresh).
    for (const p of top) if (p.confidence >= 0.3) bumpMeta(userId, p.term);
    return top;
  } catch (_) {
    return [];
  }
}

/**
 * decayUnused — drop meta entries older than `olderThanDays`. Doesn't
 * remove from RAG store (that's reserved for explicit clearUserLexicon).
 * Designed to be called by a periodic cron job.
 */
function decayUnused({ userId, olderThanDays = DEFAULT_DECAY_DAYS } = {}) {
  if (!userId) return 0;
  const inner = termMeta.get(userId);
  if (!inner) return 0;
  const cutoff = Date.now() - olderThanDays * 24 * 3600 * 1000;
  let removed = 0;
  for (const [key, meta] of inner.entries()) {
    if (meta.lastSeenAt < cutoff) {
      inner.delete(key);
      removed++;
    }
  }
  if (inner.size === 0) termMeta.delete(userId);
  return removed;
}

async function clearUserLexicon(userId) {
  if (!userId) return;
  try {
    await rag.clear(userId, collectionFor(userId));
  } catch (_) { /* swallow */ }
  termMeta.delete(userId);
}

async function lexiconStats(userId) {
  if (!userId) return { collection: null, terms: 0, meta: 0 };
  try {
    const ragStats = await rag.stats(userId, collectionFor(userId));
    const meta = termMeta.get(userId);
    return { collection: collectionFor(userId), terms: ragStats?.chunks || 0, meta: meta?.size || 0 };
  } catch (_) {
    return { collection: collectionFor(userId), terms: 0, meta: termMeta.get(userId)?.size || 0 };
  }
}

/**
 * buildLexiconBlock — formats top-K terms as a system-prompt addition.
 * Returns null when there's nothing relevant so callers can drop the
 * block entirely.
 */
function buildLexiconBlock(terms) {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  const lines = ['## PERSONAL_LEXICON',
    'Cuando el usuario use uno de estos términos, interpreta como su definición:'];
  for (const t of terms) {
    lines.push(`- "${t.term}" → ${t.definition}`);
  }
  return lines.join('\n');
}

function _clearAllForTests() {
  termMeta.clear();
}

// ─── LLM extractor (piggybacks on LTM extraction flow) ───────────────

const EXTRACT_SYSTEM = [
  "Eres un extractor de términos personales del usuario para construir su lexicón.",
  "Recibes el último intercambio (turno de usuario + respuesta) y debes identificar SOLO términos personales o abreviaturas",
  "que el usuario usa para referirse a recursos suyos (ej. 'mi CV' → un archivo o documento concreto;",
  "'el cliente premium' → una entidad específica; 'el plan Q3' → un proyecto/iniciativa).",
  "",
  "Reglas:",
  "- NO incluyas términos genéricos del lenguaje (palabras de uso común).",
  "- NO incluyas hechos personales (esos van a long-term-memory por otra ruta).",
  "- Solo extrae cuando el contexto deja claro a qué se refiere el término.",
  "- Máximo 4 términos por turno. Cero si no hay nada inequívoco.",
  "",
  "Devuelve SÓLO JSON con esta forma exacta:",
  '{"terms": [{"term": "<frase del usuario>", "definition": "<a qué se refiere, máx 200 chars>"}]}',
].join("\n");

const MAX_TERMS_PER_TURN = 4;

async function extractTermsLLM(openai, userMessage, assistantMessage) {
  if (!openai) return [];
  const transcript = `user: ${String(userMessage || '').slice(0, 3000)}\n\nassistant: ${String(assistantMessage || '').slice(0, 3000)}`;
  if (transcript.length < 20) return [];
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.0,
      max_tokens: 250,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: transcript },
      ],
    });
    const raw = resp?.choices?.[0]?.message?.content || '{}';
    const obj = JSON.parse(raw);
    const arr = Array.isArray(obj?.terms) ? obj.terms : [];
    return arr
      .filter((e) => e && typeof e.term === 'string' && typeof e.definition === 'string')
      .slice(0, MAX_TERMS_PER_TURN)
      .map((e) => ({ term: clamp(e.term, MAX_TERM_LEN), definition: clamp(e.definition, MAX_DEFINITION_LEN) }))
      .filter((e) => e.term && e.definition);
  } catch (_) {
    return [];
  }
}

/**
 * extractTermsAsync — fire-and-forget. Llamado desde el final de turn,
 * mismo patrón que long-term-memory.extractFactsAsync.
 */
function extractTermsAsync({ openai, userId, userMessage, assistantMessage }) {
  if (LEXICON_DISABLED || !userId) return;
  setImmediate(async () => {
    try {
      const terms = await extractTermsLLM(openai, userMessage, assistantMessage);
      if (terms.length === 0) return;
      await recordTermsBatch({ userId, entries: terms });
      console.log(`📚 personal-lexicon: stored ${terms.length} term(s) for user ${userId}`);
    } catch (err) {
      console.warn('[personal-lexicon] extraction failed:', err.message);
    }
  });
}

module.exports = {
  recordTerm,
  recordTermsBatch,
  lookupTerms,
  getMeta,
  decayUnused,
  clearUserLexicon,
  lexiconStats,
  buildLexiconBlock,
  collectionFor,
  // extraction (LLM-powered, fire-and-forget)
  extractTermsAsync,
  extractTermsLLM,
  EXTRACT_SYSTEM,
  MAX_TERMS_PER_TURN,
  // constants
  COLLECTION_PREFIX,
  DEFAULT_RECALL_K,
  DEFAULT_DECAY_DAYS,
  // exposed for tests
  _internal: {
    termHash,
    getMeta,
    bumpMeta,
    clamp,
    _clearAllForTests,
  },
};
