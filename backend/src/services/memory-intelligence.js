'use strict';

/**
 * memory-intelligence — the professional, structured successor to
 * memory-decision. Pure & side-effect free. Given a user prompt it produces a
 * single structured decision the chat turn can act on:
 *
 *   analyze(prompt) -> {
 *     store:  { facts: StructuredFact[] }   // durable facts the user shared
 *     recall: { should, confidence, reason, topics }
 *     forget: { should, targets: [{ query }] }
 *   }
 *
 * StructuredFact = { fact, category, attribute, value, polarity, confidence }
 *
 * Improvements over the regex-only predecessor:
 *  - Precise value capture that stops at conjunctions/punctuation, so
 *    "me llamo Luis y prefiero TypeScript" yields TWO clean facts
 *    (name=Luis, preference=TypeScript) instead of a greedy blob.
 *  - Structured attributes (name/role/location/project/preference/…) so the
 *    caller can supersede contradictions (a new name replaces the old one).
 *  - Polarity (positive/negative) for likes vs dislikes.
 *  - Confidence per fact and per recall decision.
 *  - Explicit "forget / olvida eso" detection.
 *  - Bilingual ES/EN throughout.
 */

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Capture a value and stop at the first clause boundary (conjunction or
// punctuation) so we never swallow the rest of the sentence.
const VALUE_STOP_RE = /\s+(?:y|e|o|u|pero|porque|aunque|mientras|cuando|and|or|but|because|while|so that|para que)(?:\s+|$)|[,.;:!?\n]/i;

function captureValue(text, maxLen = 80) {
  let v = String(text || '').trim();
  const m = v.match(VALUE_STOP_RE);
  if (m && m.index > 0) v = v.slice(0, m.index);
  v = v.trim().replace(/^["'“”]+|["'“”.,;:]+$/g, '').trim();
  if (v.length > maxLen) v = `${v.slice(0, maxLen).trim()}...`;
  return v;
}

function titleCase(value) {
  return String(value || '')
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// ── Hedged / transient guards: don't store uncertain statements ───────────
const HEDGE_RE = /\b(?:no se|no estoy seguro|tal vez|quiza|quizas|puede que|creo que|maybe|not sure|i think i|perhaps|posiblemente)\b/i;

// ── Structured store rules ────────────────────────────────────────────────
// Each rule captures group 1 as the value and builds a clean fact string.
const STORE_RULES = [
  {
    category: 'identity', attribute: 'name', confidence: 0.92,
    re: /\b(?:me llamo|mi nombre es|ll[aá]mame|puedes llamarme|my name is|call me)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][\wáéíóúñ'.-]*(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ'.-]*)?)/i,
    fact: (v) => `El usuario se llama ${titleCase(v)}`,
    transform: titleCase,
  },
  {
    category: 'identity', attribute: 'role', confidence: 0.8,
    re: /\b(?:trabajo como|me dedico a|i work as|i am an?|i'?m an?)\s+([^.,;\n]{2,60})/i,
    fact: (v) => `El usuario trabaja como ${v}`,
  },
  {
    category: 'identity', attribute: 'company', confidence: 0.8,
    re: /\b(?:trabajo en|i work at|i work for)\s+([^.,;\n]{2,60})/i,
    fact: (v) => `El usuario trabaja en ${v}`,
  },
  {
    category: 'identity', attribute: 'location', confidence: 0.8,
    re: /\b(?:vivo en|soy de|estoy en|i live in|i'?m from|i am from)\s+([^.,;\n]{2,60})/i,
    fact: (v) => `El usuario está en ${v}`,
  },
  {
    category: 'project', attribute: 'project', confidence: 0.78,
    re: /\b(?:mi proyecto (?:es|se llama)|estoy (?:trabajando en|construyendo|desarrollando)(?: un| una| el| la)?)\s+([^.,;\n]{2,70})/i,
    fact: (v) => `Proyecto del usuario: ${v}`,
  },
  {
    category: 'preference', attribute: null, polarity: 'negative', confidence: 0.82,
    re: /\b(?:no me gusta(?:n)?|odio|detesto|evito|i hate|i dislike|i avoid)\s+([^.,;\n]{2,80})/i,
    fact: (v) => `Al usuario no le gusta ${v}`,
  },
  {
    category: 'preference', attribute: null, polarity: 'positive', confidence: 0.82,
    // (?<!no ) so "no me gusta X" is handled only by the negative rule above.
    re: /\b(?<!no )(?:prefiero|me gusta(?:n)?|me encanta(?:n)?|siempre uso|normalmente uso|suelo usar|i prefer|i like|i love|i always use|i usually use)\s+([^.,;\n]{2,80})/i,
    fact: (v) => `El usuario prefiere ${v}`,
  },
  {
    category: 'instruction', attribute: null, confidence: 0.9,
    re: /\b(?:recuerda(?:me)?|ten en cuenta|no olvides|para que sepas|anota|remember|note|keep in mind|don'?t forget)(?: que| that)?\s+([^.\n]{3,180})/i,
    fact: (v) => v.charAt(0).toUpperCase() + v.slice(1),
    noCapture: true, // value used verbatim as the fact
  },
];

// ── Forget rules ──────────────────────────────────────────────────────────
const FORGET_RE = /\b(?:olv[ií]da(?:te)?(?: de| lo de)?|borra|elimina|ya no (?:uso|trabajo|vivo|me gusta|prefiero|quiero)|forget(?: about| that)?|delete)\s+([^.\n]{2,80})/i;

// ── Recall cues with confidence ──────────────────────────────────────────
const RECALL_EXPLICIT_RE = /\b(?:recuerda(?:s|me)?|acuerda(?:te|s)?|acuerdate|no olvides|ya te (?:dije|conte|comente|mencione|explique)|como te (?:dije|comente|mencione|conte)|lo que (?:te )?(?:dije|conte|comente|hablamos|mencione)|la (?:vez|sesion) (?:pasada|anterior)|anteriormente|recuerdas|remember|you know that i|as i (?:told|mentioned|said)|i told you|earlier i (?:said|mentioned)|like i said)\b/i;
const RECALL_IDENTITY_RE = /\b(?:como me llamo|cual es mi|cuales son mis|cual era mi|que (?:prefiero|me gusta|suelo|acostumbro)|sabes (?:mi|mis|como me|que me)|que sabes de mi|mi nombre|what'?s my|what is my|what are my|do you (?:remember|recall|know)|what do i (?:like|prefer|use|usually)|who am i)\b/i;

function extractFacts(prompt) {
  const raw = String(prompt || '');
  if (!raw.trim() || HEDGE_RE.test(raw) || HEDGE_RE.test(normalize(raw))) return [];
  const facts = [];
  const seen = new Set();
  for (const rule of STORE_RULES) {
    const m = raw.match(rule.re);
    if (!m || !m[1]) continue;
    let value = rule.noCapture ? m[1].trim() : captureValue(m[1]);
    if (rule.transform) value = rule.transform(value);
    if (!value || value.length < 2) continue;
    const factText = rule.fact(value);
    const key = normalize(factText);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      fact: factText,
      category: rule.category,
      attribute: rule.attribute || null,
      value,
      polarity: rule.polarity || 'positive',
      confidence: rule.confidence,
    });
    if (facts.length >= 4) break;
  }
  return facts;
}

function assessRecall(prompt) {
  const raw = String(prompt || '');
  const norm = normalize(raw);
  if (!norm || norm.length < 2) return { should: false, confidence: 0, reason: '', topics: [] };
  const topics = norm.split(/\s+/).filter((w) => w.length > 3).slice(0, 8);
  if (RECALL_EXPLICIT_RE.test(raw) || RECALL_EXPLICIT_RE.test(norm)) {
    return { should: true, confidence: 0.9, reason: 'El usuario hace referencia a algo dicho anteriormente.', topics };
  }
  if (RECALL_IDENTITY_RE.test(raw) || RECALL_IDENTITY_RE.test(norm)) {
    return { should: true, confidence: 0.85, reason: 'El usuario pregunta por su identidad o preferencias guardadas.', topics };
  }
  return { should: false, confidence: 0, reason: '', topics };
}

function detectForget(prompt) {
  const raw = String(prompt || '');
  const m = raw.match(FORGET_RE);
  if (!m || !m[1]) return { should: false, targets: [] };
  const query = captureValue(m[1], 80);
  if (!query || query.length < 2) return { should: false, targets: [] };
  return { should: true, targets: [{ query }] };
}

function analyze(prompt) {
  const facts = extractFacts(prompt);
  return {
    store: { facts },
    recall: assessRecall(prompt),
    forget: detectForget(prompt),
  };
}

module.exports = {
  analyze,
  extractFacts,
  assessRecall,
  detectForget,
  captureValue,
  titleCase,
  // exported for tests
  RECALL_EXPLICIT_RE,
  RECALL_IDENTITY_RE,
  FORGET_RE,
};
