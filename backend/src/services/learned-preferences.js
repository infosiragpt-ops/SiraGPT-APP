'use strict';

/**
 * learned-preferences — what THIS user has taught the platform through their
 * own corrections, kept per user and applied on every later turn.
 *
 * Signals (explicit, never guessed):
 *   - conversation repairs: «más corto», «más formal», «en inglés», «en Excel»
 *     (agents/conversation-repair.js detects them every turn);
 *   - 👎 with a reason code: too_long, too_short, invented, bad_math,
 *     incomplete, off_topic (rlhf/reason-codes.js).
 *
 * Each signal adds evidence to a trait. Evidence decays (half-life 30 days),
 * opposite traits cancel («más corto» after «más largo»), and a trait only
 * becomes an instruction once it is supported by repeated corrections — a
 * one-off «más corto» fixes that answer (the repair addendum already does)
 * but does not rewrite the user's profile. Quality flags (invented data,
 * bad math) activate on the first explicit report.
 *
 * Stored in User.settings.learnedPreferences (no migration), shown to the
 * model as a small block it applies unless the current request says
 * otherwise. Pure core + a fail-open persistence helper.
 */

const HALF_LIFE_DAYS = 30;
const DEFAULT_THRESHOLD = 1.5;
const MAX_TRAITS = 24;
const DAY_MS = 24 * 60 * 60 * 1000;

const TRAITS = Object.freeze({
  'length:shorter': { opposite: 'length:longer', text: 'Prefiere respuestas más cortas y directas.' },
  'length:longer': { opposite: 'length:shorter', text: 'Prefiere respuestas más extensas y completas.' },
  'detail:more': { opposite: 'detail:less', text: 'Prefiere más detalle y profundidad.' },
  'detail:less': { opposite: 'detail:more', text: 'Prefiere lo esencial, con menos detalle.' },
  'tone:formal': { opposite: 'tone:casual', text: 'Prefiere un tono más formal.' },
  'tone:casual': { opposite: 'tone:formal', text: 'Prefiere un tono más cercano y casual.' },
  'register:simple': { opposite: 'register:technical', text: 'Prefiere explicaciones simples, sin tecnicismos.' },
  'register:technical': { opposite: 'register:simple', text: 'Prefiere un registro más técnico.' },
  'grounding:strict': {
    threshold: 1,
    text: 'Ha marcado datos inventados: no afirmes cifras, citas ni fuentes sin respaldo y di claramente cuando no lo sabes.',
  },
  'math:verify': {
    threshold: 1,
    text: 'Ha marcado cálculos incorrectos: verifica cada cálculo paso a paso antes de responder.',
  },
  'scope:complete': {
    threshold: 1,
    text: 'Ha marcado respuestas incompletas: cubre todos los puntos que pide antes de cerrar.',
  },
  'scope:focused': {
    threshold: 1,
    text: 'Ha marcado respuestas fuera de tema: cíñete exactamente a lo que pregunta.',
  },
});

const LANGUAGE_NAMES = Object.freeze({
  es: 'español', en: 'inglés', pt: 'portugués', fr: 'francés', de: 'alemán', it: 'italiano', zh: 'chino', ja: 'japonés',
});
const FORMAT_NAMES = Object.freeze({
  docx: 'Word (.docx)', xlsx: 'Excel (.xlsx)', pdf: 'PDF', pptx: 'PowerPoint (.pptx)', md: 'Markdown',
  html: 'HTML', csv: 'CSV', json: 'JSON',
});

const SCOPE_RULES = [
  [/\b(?:m[aá]s\s+(?:corto|breve|conciso)|shorter)\b/i, 'length:shorter'],
  [/\b(?:m[aá]s\s+(?:largo|extenso)|longer)\b/i, 'length:longer'],
  [/\b(?:m[aá]s\s+(?:detallado|amplio|profundo)|more\s+detail(?:ed)?)\b/i, 'detail:more'],
  [/\b(?:menos\s+(?:detallado|extenso|largo)|less\s+detail)\b/i, 'detail:less'],
  [/\bmenos\s+(?:corto|breve)\b/i, 'length:longer'],
  [/\bm[aá]s\s+formal\b/i, 'tone:formal'],
  [/\b(?:m[aá]s\s+casual|menos\s+formal)\b/i, 'tone:casual'],
  [/\b(?:m[aá]s\s+simple|simpler|menos\s+t[eé]cnico)\b/i, 'register:simple'],
  [/\b(?:m[aá]s\s+t[eé]cnico|more\s+technical)\b/i, 'register:technical'],
];

const LANGUAGE_RULES = [
  [/espa[nñ]ol|spanish/i, 'es'],
  [/ingl[eé]s|english/i, 'en'],
  [/portugu[eé]s|portuguese/i, 'pt'],
  [/franc[eé]s|french/i, 'fr'],
  [/alem[aá]n|german/i, 'de'],
  [/italiano|italian/i, 'it'],
  [/chino|chinese/i, 'zh'],
  [/japon[eé]s|japanese/i, 'ja'],
];

const REASON_TO_TRAIT = Object.freeze({
  too_long: 'length:shorter',
  too_short: 'length:longer',
  invented: 'grounding:strict',
  bad_math: 'math:verify',
  incomplete: 'scope:complete',
  off_topic: 'scope:focused',
});

function traitDef(key) {
  if (TRAITS[key]) return TRAITS[key];
  const [kind, value] = String(key).split(':');
  if (kind === 'language' && LANGUAGE_NAMES[value]) {
    return { group: 'language', text: `Prefiere que le respondas en ${LANGUAGE_NAMES[value]}.` };
  }
  if (kind === 'format' && FORMAT_NAMES[value]) {
    return { group: 'format', text: `Cuando pide un entregable, prefiere ${FORMAT_NAMES[value]}.` };
  }
  return null;
}

function decayed(entry, now) {
  const score = Number(entry?.score) || 0;
  const last = Date.parse(entry?.lastAt || '');
  if (!Number.isFinite(last) || score <= 0) return Math.max(0, score);
  const ageDays = Math.max(0, (now - last) / DAY_MS);
  return score * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/** Trait keys implied by one repair detection (conversation-repair.js). */
function traitsFromRepair(detection) {
  if (!detection || !detection.isRepair) return [];
  const evidence = String(detection.evidence || '');
  if (detection.repairType === 'wrong_scope') {
    return SCOPE_RULES.filter(([re]) => re.test(evidence)).map(([, trait]) => trait).slice(0, 1);
  }
  if (detection.repairType === 'wrong_language') {
    const hit = LANGUAGE_RULES.find(([re]) => re.test(evidence));
    return hit ? [`language:${hit[1]}`] : [];
  }
  if (detection.repairType === 'wrong_format') {
    try {
      // eslint-disable-next-line global-require
      const ext = require('./agents/conversation-repair').extractExtensionFromEvidence(evidence);
      return ext ? [`format:${ext.replace(/^\./, '')}`] : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Trait key implied by a 👎 reason code, or null. */
function traitFromReason(reasonCode) {
  return REASON_TO_TRAIT[String(reasonCode || '').trim().toLowerCase()] || null;
}

/**
 * Pure: fold one signal into a stored preference object. Returns a NEW
 * object; the input is never mutated.
 */
function applySignal(prefs, traitKey, { weight = 1, now = Date.now(), source = 'repair' } = {}) {
  const def = traitDef(traitKey);
  if (!def) return prefs || null;
  const base = prefs && typeof prefs === 'object' ? prefs : {};
  const traits = { ...(base.traits && typeof base.traits === 'object' ? base.traits : {}) };
  const nowIso = new Date(now).toISOString();
  const current = traits[traitKey] || {};
  traits[traitKey] = {
    score: Number((decayed(current, now) + weight).toFixed(4)),
    count: (Number(current.count) || 0) + 1,
    lastAt: nowIso,
    source,
  };
  // Opposite directions cancel (a later «más largo» weakens «más corto»).
  const opposites = def.opposite ? [def.opposite] : [];
  // A language or format preference replaces the previous one of its group.
  if (def.group) {
    for (const key of Object.keys(traits)) {
      if (key !== traitKey && key.startsWith(`${def.group}:`)) opposites.push(key);
    }
  }
  for (const key of opposites) {
    if (!traits[key]) continue;
    const left = decayed(traits[key], now) - weight;
    if (left <= 0.05) delete traits[key];
    else traits[key] = { ...traits[key], score: Number(left.toFixed(4)), lastAt: nowIso };
  }
  // Keep the store small: drop the weakest traits beyond the cap.
  const keys = Object.keys(traits);
  if (keys.length > MAX_TRAITS) {
    keys
      .sort((a, b) => decayed(traits[a], now) - decayed(traits[b], now))
      .slice(0, keys.length - MAX_TRAITS)
      .forEach((key) => { delete traits[key]; });
  }
  return { version: 1, traits, updatedAt: nowIso };
}

/** Traits strong enough to steer, strongest first. */
function activeTraits(prefs, { now = Date.now() } = {}) {
  const traits = prefs && typeof prefs.traits === 'object' ? prefs.traits : {};
  return Object.entries(traits)
    .map(([key, entry]) => ({ key, def: traitDef(key), score: decayed(entry, now), count: Number(entry?.count) || 0 }))
    .filter((t) => t.def && t.score >= (t.def.threshold || DEFAULT_THRESHOLD))
    .sort((a, b) => b.score - a.score);
}

/** System-prompt block, or '' when nothing is active yet. */
function buildLearnedPreferencesBlock(prefs, { now = Date.now(), maxLines = 6 } = {}) {
  const active = activeTraits(prefs, { now }).slice(0, maxLines);
  if (!active.length) return '';
  return [
    '## PREFERENCIAS APRENDIDAS DE ESTE USUARIO',
    'Aprendidas de sus correcciones anteriores. Aplícalas por defecto; si el pedido actual pide otra cosa, manda el pedido actual.',
    ...active.map((t) => `- ${t.def.text}`),
  ].join('\n');
}

function loadLearnedPreferences(user) {
  const settings = user && typeof user.settings === 'object' && user.settings ? user.settings : null;
  const prefs = settings && settings.learnedPreferences;
  return prefs && typeof prefs === 'object' && prefs.traits && typeof prefs.traits === 'object' ? prefs : null;
}

/**
 * Persist signals for one user (read-modify-write on User.settings). Never
 * throws: learning must not affect the turn. Returns the stored object or
 * null.
 */
async function recordSignals({ prisma, userId, traits, weight = 1, source = 'repair', now = Date.now() } = {}) {
  const keys = (Array.isArray(traits) ? traits : []).filter((key) => traitDef(key));
  if (!prisma || !userId || !keys.length) return null;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
    if (!user) return null;
    const settings = user.settings && typeof user.settings === 'object' ? user.settings : {};
    let prefs = loadLearnedPreferences({ settings });
    for (const key of keys) prefs = applySignal(prefs, key, { weight, now, source });
    await prisma.user.update({
      where: { id: userId },
      data: { settings: { ...settings, learnedPreferences: prefs } },
    });
    return prefs;
  } catch {
    return null;
  }
}

module.exports = {
  TRAITS,
  HALF_LIFE_DAYS,
  DEFAULT_THRESHOLD,
  traitsFromRepair,
  traitFromReason,
  applySignal,
  activeTraits,
  buildLearnedPreferencesBlock,
  loadLearnedPreferences,
  recordSignals,
};
