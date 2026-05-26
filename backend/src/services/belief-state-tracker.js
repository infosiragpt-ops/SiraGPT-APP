'use strict';

/**
 * belief-state-tracker.js
 *
 * Tracks what the user believes about the current state of the system or
 * their own tasks across a chat thread. Examples:
 *
 *   "el bug ya está arreglado"            → belief: bug → fixed
 *   "el reporte sigue pendiente"          → belief: report → pending
 *   "ya aprobé la nueva versión"          → belief: new_version → approved
 *
 * Beliefs decay over time (older beliefs lose strength unless re-asserted)
 * and can be contradicted (a later "el bug volvió" demotes the earlier
 * "fixed" belief). Inspired by Anthropic's circuit-tracing work on
 * evidence accumulation and suppression.
 *
 * Pure heuristic, bilingual (ES + EN), no LLM, no I/O.
 */

const STORE = new Map();
const MAX_BELIEFS_PER_CHAT = Number.parseInt(process.env.SIRAGPT_BELIEF_TRACKER_MAX || '40', 10);
const DECAY_HALFLIFE_MS = Number.parseInt(process.env.SIRAGPT_BELIEF_DECAY_HALFLIFE_MS || `${6 * 60 * 60 * 1000}`, 10);

// Order matters: regressed patterns FIRST so a later "se rompió otra vez" wins
// over an earlier "está arreglado" on the same turn.
const BELIEF_PATTERNS = [
  { re: /(\b[a-z0-9_ -]{3,60})\s+(?:broke\s+again|regressed|is\s+broken\s+again|reopened)/i, status: 'regressed' },
  { re: /(\b[a-záéíóúñ0-9_ -]{3,60})\s+(?:se\s+rompi[oó]|volvi[oó]\s+a\s+(?:fallar|romperse)|otra\s+vez\s+falla)/i, status: 'regressed' },
  { re: /(\b[a-záéíóúñ0-9_ -]{3,60})\s+(?:ya\s+)?(?:est[áa]|fu[eé]|qued[oó])\s+(?:arreglad|corregid|completad|terminad|hech|listo|resuelto|cerrad|aprobad|publicad)[oa]/i, status: 'done' },
  { re: /(\b[a-záéíóúñ0-9_ -]{3,60})\s+(?:sigue|contin[uú]a|a[uú]n\s+est[áa]|todav[ií]a\s+est[áa])\s+(?:pendiente|incomplet|fallando|roto|sin\s+resolver|en\s+curso)/i, status: 'pending' },
  { re: /(\b[a-záéíóúñ0-9_ -]{3,60})\s+(?:no\s+(?:est[áa]|fu[eé])|nunca\s+fue)\s+(?:arreglad|corregid|aprobad|publicad)/i, status: 'not_done' },
  { re: /\b(?:ya\s+)?aprob[eéó]\s+(?:el\s+|la\s+)?(\b[a-záéíóúñ0-9_ -]{3,60})/i, status: 'approved' },
  { re: /(\b[a-z0-9_ -]{3,60})\s+is\s+(?:now\s+)?(?:fixed|done|completed|finished|ready|resolved|approved|published|shipped|deployed)/i, status: 'done' },
  { re: /(\b[a-z0-9_ -]{3,60})\s+is\s+still\s+(?:pending|broken|failing|in\s+progress|unresolved|open)/i, status: 'pending' },
  { re: /(\b[a-z0-9_ -]{3,60})\s+(?:is\s+not|isn'?t|has\s+not\s+been)\s+(?:fixed|done|approved|published)/i, status: 'not_done' },
  { re: /\b(?:i|we)\s+(?:already\s+)?approved\s+(?:the\s+)?(\b[a-z0-9_ -]{3,60})/i, status: 'approved' },
];

const STOP_SUBJECT_TOKENS = new Set([
  'ya', 'no', 'sí', 'si', 'aún', 'aun', 'que', 'lo', 'los', 'las', 'el', 'la',
  'un', 'una', 'de', 'para', 'por', 'con', 'sin', 'espera',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'still', 'not', 'has', 'been',
]);

function key(userId, chatId) {
  return `${String(userId || 'anon')}:${String(chatId || 'default')}`;
}

function getStore(userId, chatId, { createIfMissing = false } = {}) {
  const k = key(userId, chatId);
  let slot = STORE.get(k);
  if (!slot && createIfMissing) {
    slot = new Map();
    STORE.set(k, slot);
  }
  return slot;
}

function normalizeSubject(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñ_ -]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = s.split(' ').filter((t) => t && !STOP_SUBJECT_TOKENS.has(t));
  return tokens.join(' ').slice(0, 60);
}

function beliefId(subject, status) {
  return Buffer.from(`${subject}|${status}`).toString('base64').slice(0, 16);
}

function decayWeight(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  const hl = Math.max(60_000, DECAY_HALFLIFE_MS);
  return Math.pow(0.5, ageMs / hl);
}

const CONTRADICTORY_STATUSES = new Map([
  ['done', new Set(['pending', 'not_done', 'regressed'])],
  ['pending', new Set(['done', 'approved'])],
  ['not_done', new Set(['done', 'approved'])],
  ['regressed', new Set(['done', 'approved'])],
  ['approved', new Set(['pending', 'not_done'])],
]);

function detectContradictionsFor(slot, subject, status) {
  if (!slot) return [];
  const out = [];
  for (const b of slot.values()) {
    if (b.subject !== subject) continue;
    if (b.status === status) continue;
    if (CONTRADICTORY_STATUSES.get(status)?.has(b.status)) out.push(b);
  }
  return out;
}

function evictIfTooMany(slot) {
  if (slot.size <= MAX_BELIEFS_PER_CHAT) return;
  const sorted = [...slot.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  const toEvict = sorted.slice(0, slot.size - MAX_BELIEFS_PER_CHAT);
  for (const b of toEvict) slot.delete(b.id);
}

function observe({ userId, chatId, turnIndex = 0, prompt = '' } = {}) {
  const text = String(prompt || '').slice(0, 4000);
  if (!text.trim()) return { observed: [], contradicted: [] };
  const slot = getStore(userId, chatId, { createIfMissing: true });
  const now = Date.now();
  const observed = [];
  const contradicted = [];
  const seenInTurn = new Set();

  for (const pat of BELIEF_PATTERNS) {
    const re = new RegExp(pat.re.source, pat.re.flags.includes('g') ? pat.re.flags : `${pat.re.flags}g`);
    let m;
    while ((m = re.exec(text)) !== null) {
      const rawSubject = m[1] || '';
      const subject = normalizeSubject(rawSubject);
      if (!subject || subject.length < 2) continue;
      const status = pat.status;
      // Only one belief per (subject, turn) — the first matching pattern wins
      // (order in BELIEF_PATTERNS encodes precedence).
      const dedupKey = `${subject}|${turnIndex}`;
      if (seenInTurn.has(dedupKey)) continue;
      seenInTurn.add(dedupKey);
      const id = beliefId(subject, status);

      const conflicts = detectContradictionsFor(slot, subject, status);
      for (const c of conflicts) {
        c.contradictedAt = now;
        c.contradictedBy = id;
        contradicted.push({ ...c });
      }

      const prev = slot.get(id);
      if (prev) {
        prev.observations += 1;
        prev.lastSeenAt = now;
        prev.lastTurnIndex = turnIndex;
        prev.strength = Math.min(1, prev.strength + 0.15);
        observed.push({ ...prev, isNew: false });
      } else {
        const entry = {
          id,
          subject,
          status,
          rawSurface: m[0].slice(0, 160),
          firstSeenAt: now,
          firstTurnIndex: turnIndex,
          lastSeenAt: now,
          lastTurnIndex: turnIndex,
          observations: 1,
          strength: 0.6,
          contradictedAt: null,
          contradictedBy: null,
        };
        slot.set(id, entry);
        observed.push({ ...entry, isNew: true });
      }
    }
  }
  evictIfTooMany(slot);
  return { observed, contradicted };
}

function list({ userId, chatId, limit = 25 } = {}) {
  const slot = getStore(userId, chatId);
  if (!slot) return [];
  const now = Date.now();
  return [...slot.values()]
    .map((b) => {
      const decay = decayWeight(now - b.lastSeenAt);
      return { ...b, currentStrength: Number((b.strength * decay).toFixed(3)) };
    })
    .sort((a, b) => b.currentStrength - a.currentStrength)
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 25)));
}

function contradict({ userId, chatId, beliefId: bid } = {}) {
  const slot = getStore(userId, chatId);
  if (!slot) return { contradicted: 0 };
  const b = slot.get(bid);
  if (!b) return { contradicted: 0 };
  b.contradictedAt = Date.now();
  return { contradicted: 1 };
}

function reset({ userId, chatId } = {}) {
  const k = key(userId, chatId);
  const slot = STORE.get(k);
  if (!slot) return { cleared: 0 };
  const n = slot.size;
  STORE.delete(k);
  return { cleared: n };
}

function _reset() { STORE.clear(); }

function buildBeliefBlock({ userId, chatId, max = 8 } = {}) {
  const beliefs = list({ userId, chatId, limit: max });
  if (!beliefs.length) return '';
  const active = beliefs.filter((b) => !b.contradictedAt);
  const contradicted = beliefs.filter((b) => b.contradictedAt);
  const lines = ['## USER BELIEF STATE'];
  if (active.length) {
    lines.push('Currently active beliefs (treat as user assumptions):');
    for (const b of active) {
      lines.push(`- ${b.subject} → **${b.status}** (strength ${b.currentStrength}, obs ${b.observations})`);
    }
  }
  if (contradicted.length) {
    lines.push('Previously stated but contradicted (do not assume still true):');
    for (const b of contradicted) {
      lines.push(`- ${b.subject} → ${b.status} (contradicted)`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  observe,
  list,
  contradict,
  reset,
  _reset,
  buildBeliefBlock,
  BELIEF_PATTERNS,
  CONTRADICTORY_STATUSES,
};
