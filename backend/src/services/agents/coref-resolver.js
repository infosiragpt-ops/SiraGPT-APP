'use strict';

/**
 * coref-resolver
 *
 * Resuelve coreferencias multi-turno ("eso", "el anterior", "la segunda
 * parte", "mi CV") sustituyendo o anotando el referente concreto antes
 * de que el LLM grande procese el mensaje. Esto mejora la precisión en
 * chats largos donde el usuario asume contexto y el modelo lo pierde.
 *
 * Pipeline:
 *   1. detectAnaphors(prompt): regex local determinista. Si no hay
 *      anclas, retornar early sin invocar judge (zero cost).
 *   2. Cache LRU por (promptHash + lastTurnHash). TTL 5min, max 500.
 *   3. Si miss, llamar judge ligero con timeout 250ms.
 *   4. Si confidence >= 0.6 → reemplaza la ancla en resolvedPrompt.
 *      Si confidence en [0.3, 0.6) → preserva prompt, anota como hint
 *      low-confidence al system prompt.
 *      Si confidence < 0.3 o judge timeout → no se sustituye.
 *
 * El módulo es PURO en su core (detectAnaphors, applyResolution,
 * cache) y solo el wrapper exterior toca I/O.
 *
 * Falla silenciosa: cualquier excepción retorna el prompt original.
 */

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_HIGH_CONFIDENCE = 0.6;
const DEFAULT_HINT_CONFIDENCE = 0.3;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

// Regex de anclas (español + inglés). Cuidado con falsos positivos:
// preferimos especificidad. Cada match captura el span concreto.
// Orden importa para evitar overlaps confusos.
const ANAPHOR_PATTERNS = [
  // Frases ordinales: "la segunda parte", "el primero", "el tercero"
  { name: 'ordinal_part', re: /\b(?:el\s+|la\s+|los\s+|las\s+)?(?:primer[oa]?|segund[oa]|tercer[oa]?|cuart[oa]|últim[oa])(?:\s+(?:parte|punto|opci[oó]n|idea|sección|capítulo))?\b/i },
  // Documentos referidos: "el documento", "el código de arriba", "esa imagen"
  { name: 'doc_ref', re: /\b(?:el|la|este|esta|ese|esa|aquel|aquella)\s+(?:documento|archivo|c[oó]digo|texto|p[aá]rrafo|imagen|figura|tabla|gr[aá]fico|video|audio|adjunto)(?:\s+(?:de\s+arriba|previo|anterior|de\s+antes|adjunto))?\b/i },
  // "mi cv", "mi plan", "mi proyecto", "mi empresa"
  { name: 'personal_ref', re: /\b(?:mi|mis|nuestro|nuestra)\s+(?:cv|curriculum|currículum|resumen|plan|proyecto|empresa|tesis|borrador|propuesta|presupuesto|informe|reporte|c[oó]digo|api|cliente|product[oa])\b/i },
  // Deícticos puros al inicio: "eso", "esto", "esto mismo", "lo mismo"
  { name: 'demonstrative', re: /\b(?:eso|esto|aquello|esa|ese|aquel|aquella)(?:\s+mismo)?\b/i },
  // "el anterior", "el de antes", "lo anterior"
  { name: 'previous_ref', re: /\b(?:el|la|lo|los|las)\s+(?:anterior|de\s+antes|previo|previa)\b/i },
  // Pronombres clíticos + verbos: "hazlo", "mejóralo", "tradúcelo", "resúmelo"
  { name: 'enclitic', re: /\b(?:h[aá]zlo|mej[oó]ralo|tradúcelo|tradúcelos?|res[uú]melo|am[pl]i[aá]lo|cambialo|edítalo|corrígelo|borralo|gu[aá]rdalo|exp[aá]ndelo|repítelo)\b/i },
  // English fallback: "that", "the previous", "the second one", "the document"
  { name: 'english_ref', re: /\b(?:that|the\s+(?:previous|second|first|third|last)(?:\s+one)?|the\s+(?:document|file|image|code|previous\s+answer))\b/i },
];

function normalizeForCache(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function hashKey(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(normalizeForCache(p)).update('|');
  return h.digest('hex').slice(0, 24);
}

function detectAnaphors(prompt) {
  if (!prompt || typeof prompt !== 'string') return [];
  const found = [];
  const seen = new Set();
  for (const { name, re } of ANAPHOR_PATTERNS) {
    const m = prompt.match(re);
    if (m && m[0]) {
      const span = m[0];
      const key = `${name}:${span.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ name, span, index: m.index });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

// ─── LRU cache ───────────────────────────────────────────────────────

const cache = new Map(); // key -> { value, expiresAt }

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  // bump to MRU
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Drop LRU (first key in insertion-order Map)
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function _clearCacheForTests() {
  cache.clear();
}

// ─── Pure: apply resolved references to prompt text ──────────────────

function applyResolution({ prompt, references = [] }) {
  if (!references || references.length === 0) return prompt;
  let resolved = prompt;
  for (const ref of references) {
    if (!ref || !ref.span || !ref.resolvesTo || ref.confidence < DEFAULT_HIGH_CONFIDENCE) continue;
    // Sustituir la primera ocurrencia case-insensitive sin tocar el resto.
    const idx = resolved.toLowerCase().indexOf(String(ref.span).toLowerCase());
    if (idx < 0) continue;
    const head = resolved.slice(0, idx);
    const tail = resolved.slice(idx + ref.span.length);
    resolved = `${head}${ref.resolvesTo}${tail}`;
  }
  return resolved;
}

// ─── Fallback semántico por cosine ───────────────────────────────────

function buildCosineFallback(recentTurns, anaphor) {
  // Heurística sin LLM: el referente más probable es el último mensaje
  // assistant que contenga un sustantivo. Para anaforas como "el documento"
  // buscamos el último turno que mencione un sustantivo similar.
  if (!Array.isArray(recentTurns) || recentTurns.length === 0) return null;
  // Filtra los turnos assistant más recientes y toma el último no vacío.
  for (let i = recentTurns.length - 1; i >= 0; i--) {
    const t = recentTurns[i];
    const text = String(t?.text || t?.content || '').trim();
    if (!text) continue;
    if (t.role === 'assistant') {
      // Devuelve un snippet corto representativo
      return { resolvesTo: text.slice(0, 120), confidence: 0.4, source: 'cosine_fallback' };
    }
  }
  return null;
}

// ─── Main entry ──────────────────────────────────────────────────────

/**
 * resolveCoreferences
 *
 * @param {object} args
 * @param {string} args.prompt
 * @param {Array}  [args.recentTurns=[]]  — [{role, text|content}]
 * @param {Array}  [args.attachments=[]]  — [{name|filename|id}]
 * @param {Function} [args.judge]         — async corefJudge(args) => {resolvesTo, confidence}
 * @param {object} [args.options]
 * @returns {Promise<{resolvedPrompt: string, references: Array, source: string, latencyMs: number}>}
 */
async function resolveCoreferences({ prompt, recentTurns = [], attachments = [], judge = null, options = {} } = {}) {
  const t0 = Date.now();
  const empty = {
    resolvedPrompt: String(prompt || ''),
    references: [],
    source: 'no_anchor',
    latencyMs: 0,
  };
  try {
    const anaphors = detectAnaphors(prompt);
    if (anaphors.length === 0) {
      empty.latencyMs = Date.now() - t0;
      return empty;
    }

    // Sin historial ni adjuntos → no podemos resolver. Anclamos como hint
    // low-confidence pero NO sustituimos.
    const hasContext = (Array.isArray(recentTurns) && recentTurns.length > 0) || (Array.isArray(attachments) && attachments.length > 0);
    if (!hasContext) {
      return {
        resolvedPrompt: String(prompt || ''),
        references: anaphors.map((a) => ({ ...a, resolvesTo: null, confidence: 0, source: 'no_context' })),
        source: 'no_context',
        latencyMs: Date.now() - t0,
      };
    }

    const lastTurnText = recentTurns[recentTurns.length - 1]?.text || recentTurns[recentTurns.length - 1]?.content || '';
    const cacheKey = hashKey(prompt, lastTurnText, JSON.stringify(attachments?.slice(0, 3) || []));
    const cached = cacheGet(cacheKey);
    if (cached) {
      return { ...cached, source: 'cache', latencyMs: Date.now() - t0 };
    }

    const references = [];
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

    // Resolución por ancla — paralelizable. Por ahora resolvemos solo
    // la primera ancla para economizar tokens; la segunda (rara) cae al
    // hint low-confidence.
    const primary = anaphors[0];

    let resolution = null;
    if (typeof judge === 'function') {
      try {
        resolution = await withTimeout(
          Promise.resolve(judge({
            anaphor: primary.span,
            prompt,
            recentTurns,
            attachments,
          })),
          timeoutMs,
        );
      } catch (err) {
        resolution = null;
      }
    }

    // Fallback semántico si judge no resolvió.
    if (!resolution || !resolution.resolvesTo || (resolution.confidence || 0) < DEFAULT_HINT_CONFIDENCE) {
      resolution = buildCosineFallback(recentTurns, primary.span);
    }

    if (resolution && resolution.resolvesTo) {
      references.push({
        anaphor: primary.span,
        span: primary.span,
        resolvesTo: resolution.resolvesTo,
        confidence: typeof resolution.confidence === 'number' ? resolution.confidence : 0.5,
        source: resolution.source || 'judge',
      });
    }

    // Anclas adicionales se anotan como hints sin resolución (low-conf).
    for (let i = 1; i < anaphors.length; i++) {
      references.push({
        anaphor: anaphors[i].span,
        span: anaphors[i].span,
        resolvesTo: null,
        confidence: 0,
        source: 'secondary',
      });
    }

    const resolvedPrompt = applyResolution({ prompt, references });
    const result = {
      resolvedPrompt,
      references,
      source: references[0]?.source || 'no_match',
      latencyMs: Date.now() - t0,
    };
    cacheSet(cacheKey, { resolvedPrompt: result.resolvedPrompt, references: result.references });
    return result;
  } catch (_err) {
    return { ...empty, source: 'error', latencyMs: Date.now() - t0 };
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('coref_judge_timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── Prompt block builder for master-prompt ──────────────────────────

function buildCorefPromptBlock(references = []) {
  const resolved = references.filter((r) => r.resolvesTo && r.confidence >= DEFAULT_HIGH_CONFIDENCE);
  const lowConf = references.filter((r) => r.resolvesTo && r.confidence < DEFAULT_HIGH_CONFIDENCE && r.confidence >= DEFAULT_HINT_CONFIDENCE);
  if (resolved.length === 0 && lowConf.length === 0) return null;
  const lines = ['## COREFERENCE_RESOLUTION'];
  if (resolved.length > 0) {
    lines.push('El usuario usó referencias deícticas que han sido resueltas. Trabaja sobre el referente resuelto:');
    for (const r of resolved) {
      lines.push(`- "${r.span}" → ${r.resolvesTo} (conf ${r.confidence.toFixed(2)})`);
    }
  }
  if (lowConf.length > 0) {
    lines.push('');
    lines.push('Posibles referentes (confianza baja — confírmalos si dudas):');
    for (const r of lowConf) {
      lines.push(`- "${r.span}" probable: ${r.resolvesTo} (conf ${r.confidence.toFixed(2)})`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  resolveCoreferences,
  detectAnaphors,
  applyResolution,
  buildCorefPromptBlock,
  ANAPHOR_PATTERNS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_HIGH_CONFIDENCE,
  DEFAULT_HINT_CONFIDENCE,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  // exposed for tests
  _internal: {
    detectAnaphors,
    applyResolution,
    buildCosineFallback,
    hashKey,
    cacheGet,
    cacheSet,
    _clearCacheForTests,
    withTimeout,
  },
};
