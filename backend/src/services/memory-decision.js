'use strict';

/**
 * memory-decision — deterministic, bilingual (ES/EN) heuristics that let the
 * chat turn DECIDE, on its own, two things:
 *
 *   1. shouldRecall: is this turn referencing the user's personal/past context
 *      such that recalling stored memory is actually necessary? (We do NOT
 *      recall on every turn — only when it's relevant, to avoid noise.)
 *
 *   2. shouldStore: did the user just share a durable fact worth remembering
 *      (identity / preference / explicit "remember that …")? If so, return the
 *      normalized fact(s) + a category so the caller can persist them.
 *
 * Pure & side-effect free: the caller (routes/ai.js) owns the actual
 * active-memory store/recall calls. Keeping the decision here makes it unit
 * testable and reusable.
 */

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Recall cues: the turn explicitly leans on remembered context ──────────
// Explicit "remember / you told me / as I said" style references.
const RECALL_EXPLICIT_RE = /\b(recuerda(?:s|me)?|acuerda(?:te|s)?|acuerdate|no olvides|ya te (?:dije|conte|comente|mencione|explique)|como te (?:dije|comente|mencione|conte)|lo que (?:te )?(?:dije|conte|comente|hablamos|mencione)|la (?:vez|sesion) (?:pasada|anterior)|anteriormente|recuerdas|remember|you know that i|as i (?:told|mentioned|said)|i told you|earlier i (?:said|mentioned)|like i said)\b/i;

// Identity / preference questions aimed at the user's own stored profile.
const RECALL_IDENTITY_RE = /\b(?:como me llamo|cual es mi|cuales son mis|cual era mi|que (?:prefiero|me gusta|suelo|acostumbro)|sabes (?:mi|mis|como me|que me)|que sabes de mi|mi nombre|what'?s my|what is my|what are my|do you (?:remember|recall|know)|what do i (?:like|prefer|use|usually)|who am i)\b/i;

// ── Store cues: the user is stating a durable fact about themselves ───────
// Each rule captures the fact text in group 1 (or implies the whole clause).
const STORE_RULES = [
  // Explicit "remember that X" / "no olvides que X"
  { category: 'instruction', re: /\b(?:recuerda(?:me)?|ten en cuenta|no olvides|para que sepas|anota) que\s+(.{3,200})/i },
  { category: 'instruction', re: /\b(?:remember|note|keep in mind|don'?t forget) that\s+(.{3,200})/i },
  // Identity: name
  { category: 'identity', re: /\b(?:me llamo|mi nombre es|puedes llamarme|llamame)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][\w .'-]{1,60})/i, prefix: 'El usuario se llama ' },
  { category: 'identity', re: /\b(?:my name is|call me|i am called)\s+([A-Za-z][\w .'-]{1,60})/i, prefix: 'The user is named ' },
  // Identity / role: "soy X", "trabajo como/en X", "estudio X"
  { category: 'identity', re: /\b(?:soy|trabajo (?:como|en|de)|me dedico a|estudio)\s+(.{2,120})/i, prefix: 'El usuario: ' },
  { category: 'identity', re: /\bi(?:'m| am| work as| work at| study)\s+(.{2,120})/i, prefix: 'The user: ' },
  // Preference
  { category: 'preference', re: /\b(?:prefiero|me gusta(?:n)?|me encanta(?:n)?|odio|no me gusta(?:n)?|siempre uso|normalmente uso|suelo usar)\s+(.{2,160})/i, prefix: 'Preferencia: ' },
  { category: 'preference', re: /\bi (?:prefer|like|love|hate|always use|usually use|dislike)\s+(.{2,160})/i, prefix: 'Preference: ' },
];

// Guard: don't treat throwaway "soy/me gusta" inside obvious code/tasking as a
// durable fact when the clause is clearly transient.
const STORE_BLOCKLIST_RE = /\b(?:no se|no estoy seguro|tal vez|quiza|maybe|not sure|i think i)\b/i;

function clampFact(text) {
  let fact = String(text || '').trim();
  // Cut at sentence end / clause boundary so we don't store a whole paragraph.
  fact = fact.split(/[.!?\n]/)[0].trim();
  if (fact.length > 200) fact = `${fact.slice(0, 197).trim()}...`;
  return fact;
}

/**
 * Decide whether the current turn should recall memory.
 * @returns {{ recall: boolean, reason: string }}
 */
function shouldRecall(prompt) {
  const raw = String(prompt || '');
  const norm = normalize(raw);
  if (!norm || norm.length < 2) return { recall: false, reason: '' };
  if (RECALL_EXPLICIT_RE.test(raw) || RECALL_EXPLICIT_RE.test(norm)) {
    return { recall: true, reason: 'El usuario hace referencia a algo dicho anteriormente.' };
  }
  if (RECALL_IDENTITY_RE.test(raw) || RECALL_IDENTITY_RE.test(norm)) {
    return { recall: true, reason: 'El usuario pregunta por su identidad o preferencias guardadas.' };
  }
  return { recall: false, reason: '' };
}

/**
 * Decide whether the current turn should store new facts.
 * @returns {{ store: boolean, facts: Array<{fact:string, category:string}> }}
 */
function shouldStore(prompt) {
  const raw = String(prompt || '');
  if (!raw.trim()) return { store: false, facts: [] };
  if (STORE_BLOCKLIST_RE.test(raw)) return { store: false, facts: [] };
  const facts = [];
  const seen = new Set();
  for (const rule of STORE_RULES) {
    const m = raw.match(rule.re);
    if (!m) continue;
    const captured = clampFact(m[1]);
    if (!captured || captured.length < 2) continue;
    const fact = `${rule.prefix || ''}${captured}`.trim();
    const key = normalize(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ fact, category: rule.category });
    if (facts.length >= 3) break; // cap per turn
  }
  return { store: facts.length > 0, facts };
}

/**
 * One-call decision combining recall + store.
 * @returns {{ recall:boolean, reason:string, store:boolean, facts:Array<{fact,category}> }}
 */
function decide(prompt) {
  const r = shouldRecall(prompt);
  const s = shouldStore(prompt);
  return { recall: r.recall, reason: r.reason, store: s.store, facts: s.facts };
}

module.exports = {
  decide,
  shouldRecall,
  shouldStore,
  clampFact,
  // exported for tests
  RECALL_EXPLICIT_RE,
  RECALL_IDENTITY_RE,
};
