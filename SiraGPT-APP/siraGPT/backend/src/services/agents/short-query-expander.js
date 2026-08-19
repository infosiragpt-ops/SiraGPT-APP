'use strict';

/**
 * short-query-expander
 *
 * Cuando el usuario escribe muy poco (<10 tokens), el router/triage
 * tienen poca señal y suelen marcar como ambiguous por defecto. Esta
 * capa expande el prompt SOLO para el router (no para el LLM grande)
 * añadiendo:
 *   - Keywords del lexicón personal del usuario que coincidan
 *     semánticamente con el prompt (si está disponible).
 *   - Keywords de la query existente vía query-expansion.js
 *     (Iliagpt pattern: extracción de stop-words).
 *   - Contexto mínimo del último turno assistant (snippet 60 chars).
 *
 * El prompt original siempre se preserva en el output. La expansión
 * sólo alimenta al router/triage; el LLM grande sigue viendo el
 * mensaje literal del usuario.
 *
 * Idempotente: si el prompt ya tiene >= TOKEN_THRESHOLD tokens, retorna
 * `{ expanded: prompt, original: prompt, source: 'no_expansion' }`.
 *
 * Fail-open: cualquier error retorna el prompt original.
 */

const queryExpansion = require('../query-expansion');

const TOKEN_THRESHOLD = 10;
const MAX_EXPANDED_LEN = 600;

function tokenCount(text) {
  if (!text || typeof text !== 'string') return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function clampLen(text, max = MAX_EXPANDED_LEN) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * expandShortQuery
 *
 * @param {object} args
 * @param {string} args.prompt
 * @param {Array}  [args.recentTurns=[]] — [{role, text}] últimos turnos
 * @param {Array}  [args.lexiconTerms=[]] — [{term, definition}] del lexicón
 * @param {number} [args.threshold=TOKEN_THRESHOLD] — sobre cuántos tokens NO expandir
 * @returns {{expanded: string, original: string, source: string, additions: string[]}}
 */
function expandShortQuery({ prompt, recentTurns = [], lexiconTerms = [], threshold = TOKEN_THRESHOLD } = {}) {
  const original = String(prompt || '').trim();
  if (!original) return { expanded: '', original: '', source: 'empty', additions: [] };

  const tokens = tokenCount(original);
  if (tokens >= threshold) {
    return { expanded: original, original, source: 'no_expansion', additions: [] };
  }

  const additions = [];

  // 1) Lexicón personal: si algún término del lexicón aparece en el prompt
  //    o es muy similar, añadir su definición como contexto.
  try {
    const lowered = original.toLowerCase();
    for (const t of lexiconTerms.slice(0, 3)) {
      if (!t || !t.term || !t.definition) continue;
      const termL = String(t.term).toLowerCase();
      if (lowered.includes(termL) || lowered.includes(termL.split(/\s+/).pop())) {
        additions.push(`(${t.term} = ${clampLen(t.definition, 120)})`);
      }
    }
  } catch (_) { /* swallow */ }

  // 2) Keywords vía query-expansion existente
  try {
    const eq = queryExpansion.expandQuery(original);
    if (eq && Array.isArray(eq.keywords) && eq.keywords.length > 0) {
      const extra = eq.keywords.filter((k) => !original.toLowerCase().includes(k.toLowerCase()));
      if (extra.length > 0) additions.push(`keywords: ${extra.slice(0, 5).join(', ')}`);
    }
  } catch (_) { /* swallow */ }

  // 3) Contexto mínimo del último turno assistant
  try {
    if (Array.isArray(recentTurns) && recentTurns.length > 0) {
      for (let i = recentTurns.length - 1; i >= 0; i--) {
        const t = recentTurns[i];
        if (t?.role === 'assistant' && (t.text || t.content)) {
          additions.push(`contexto previo: ${clampLen(t.text || t.content, 80)}`);
          break;
        }
      }
    }
  } catch (_) { /* swallow */ }

  if (additions.length === 0) {
    return { expanded: original, original, source: 'no_additions', additions: [] };
  }

  const expanded = clampLen(`${original} [${additions.join(' | ')}]`);
  return { expanded, original, source: 'expanded', additions };
}

module.exports = {
  expandShortQuery,
  tokenCount,
  TOKEN_THRESHOLD,
  MAX_EXPANDED_LEN,
};
