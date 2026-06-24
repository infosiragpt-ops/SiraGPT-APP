'use strict';

/**
 * constraint-adherence.js — "do EXACTLY what was asked".
 * ───────────────────────────────────────────────────────────────────────────
 * The single biggest perceived-quality gap between a mediocre assistant and a
 * frontier one (Claude/ChatGPT) is INSTRUCTION FOLLOWING: honoring "in one
 * paragraph", "in English", "include a bar chart", "without the cover page",
 * "max 200 words". This module makes those constraints first-class:
 *
 *   1. extractConstraints(prompt)       — parse explicit, checkable constraints
 *   2. buildConstraintPromptBlock(...)  — inject a hard "MUST satisfy" checklist
 *                                          into the system prompt (pre-gen)
 *   3. verifyAdherence(response, ...)    — check the draft against them and
 *                                          return concrete violations + a fix
 *                                          instruction (post-gen)
 *
 * Pure, deterministic, bilingual (ES/EN). No LLM. Heuristic but conservative:
 * the verifier only flags constraints it can check reliably (length, count,
 * language, include/exclude, directness) to avoid false positives.
 *
 * Public API:
 *   extractConstraints(prompt, opts?)            → Constraint[]
 *   verifyAdherence(response, constraints, opts?) → { satisfied, violations, score, fixInstruction }
 *   buildConstraintPromptBlock(constraints, opts?) → string
 *   summarizeForLog(result)                      → string
 */

const NUM_WORDS = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  'un solo': 1, 'una sola': 1, single: 1,
};

function toNum(token) {
  if (token == null) return null;
  const s = String(token).trim().toLowerCase();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return NUM_WORDS[s] != null ? NUM_WORDS[s] : null;
}

function clampTerm(s, max = 60) {
  const t = String(s || '').trim().replace(/["“”'.;:]+$/, '').trim();
  return t.length > max ? t.slice(0, max).trim() : t;
}

const STOPWORDS = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'y', 'o', 'the', 'a', 'an', 'of', 'and', 'or', 'with', 'con', 'que', 'para', 'en', 'su', 'sus']);

function significantTokens(term) {
  return String(term || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

// ── Extraction ───────────────────────────────────────────────────────────────

function extractConstraints(prompt, opts = {}) {
  const text = String(prompt || '');
  const lower = text.toLowerCase();
  const out = [];
  const seen = new Set();
  const add = (c) => {
    const key = `${c.kind}:${c.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  // ── Length: paragraphs ─────────────────────────────────────────────
  let m = lower.match(/\b(?:en|in)\s+(un solo|una sola|\d+|un|una|dos|tres|cuatro|cinco|single|one|two|three)\s+(p[áa]rrafos?|paragraphs?)\b/);
  if (m) {
    const n = toNum(m[1]) || 1;
    add({ kind: 'length_paragraphs', value: n, op: 'exact', raw: m[0], verifiable: true });
  } else if (/\b(un solo p[áa]rrafo|en un p[áa]rrafo|single paragraph|one paragraph)\b/.test(lower)) {
    add({ kind: 'length_paragraphs', value: 1, op: 'exact', raw: 'un solo párrafo', verifiable: true });
  }

  // ── Length: sentences ──────────────────────────────────────────────
  m = lower.match(/\b(?:en|in)\s+(un[ao]?|\d+|dos|tres|single|one|two|three)\s+(frases?|oraciones?|l[ií]neas?|sentences?|lines?)\b/);
  if (m) {
    const n = toNum(m[1]) || 1;
    add({ kind: 'length_sentences', value: n, op: 'exact', raw: m[0], verifiable: true });
  } else if (/\b(una sola (frase|oraci[óo]n|l[íi]nea)|in one sentence|single sentence)\b/.test(lower)) {
    add({ kind: 'length_sentences', value: 1, op: 'exact', raw: 'una sola frase', verifiable: true });
  }

  // ── Length: words ──────────────────────────────────────────────────
  m = lower.match(/\b(m[áa]ximo|max(?:imum)?|no m[áa]s de|hasta|menos de|under|at most)\s+(\d+)\s+(palabras?|words?)\b/);
  if (m) add({ kind: 'length_words', value: parseInt(m[2], 10), op: 'max', raw: m[0], verifiable: true });
  m = lower.match(/\b(al menos|m[íi]nimo|at least|minimum)\s+(\d+)\s+(palabras?|words?)\b/);
  if (m) add({ kind: 'length_words', value: parseInt(m[2], 10), op: 'min', raw: m[0], verifiable: true });
  m = lower.match(/\b(?:en|de|in|of)\s+(\d+)\s+(palabras?|words?)\b/);
  if (m && !out.some((c) => c.kind === 'length_words')) {
    add({ kind: 'length_words', value: parseInt(m[1], 10), op: 'about', raw: m[0], verifiable: true });
  }

  // ── Length: list items ─────────────────────────────────────────────
  m = lower.match(/\b(\d+)\s+(puntos?|bullets?|vi[ñn]etas?|[íi]tems?|elementos?|pasos?|steps?|points?)\b/);
  if (m) add({ kind: 'length_items', value: parseInt(m[1], 10), op: 'about', raw: m[0], verifiable: true });
  m = lower.match(/\b(lista|list)\s+(?:de|of)\s+(\d+)\b/);
  if (m) add({ kind: 'length_items', value: parseInt(m[2], 10), op: 'about', raw: m[0], verifiable: true });

  // ── Language ───────────────────────────────────────────────────────
  if (/\b(responde|escribe|contesta|tradu[czc]e?(?:lo)?|answer|write|respond|reply)\b[^.]*\b(en|in|to|al)\s+(ingl[ée]s|english)\b/.test(lower) || /\bin english\b/.test(lower)) {
    add({ kind: 'language', value: 'en', raw: 'en inglés', verifiable: true });
  }
  if (/\b(responde|escribe|contesta|answer|write|respond)\b[^.]*\b(en|in)\s+(espa[ñn]ol|spanish)\b/.test(lower)) {
    add({ kind: 'language', value: 'es', raw: 'en español', verifiable: true });
  }
  if (/\b(en|in)\s+(franc[ée]s|french)\b/.test(lower)) add({ kind: 'language', value: 'fr', raw: 'en francés', verifiable: true });
  if (/\b(en|in)\s+(portugu[ée]s|portuguese)\b/.test(lower)) add({ kind: 'language', value: 'pt', raw: 'en portugués', verifiable: true });

  // ── Must include ───────────────────────────────────────────────────
  const includeRe = /\b(incluye|incluya|incluir|incluyendo|que (?:incluya|tenga|contenga|mencione)|aseg[úu]rate de incluir|include|including|make sure to include|with a (?:section|part) (?:on|about))\s+([^.,;:\n]{3,60})/gi;
  let im;
  while ((im = includeRe.exec(text)) !== null) {
    const term = clampTerm(im[2]);
    if (term && significantTokens(term).length > 0) {
      add({ kind: 'must_include', value: term.toLowerCase(), raw: im[0].trim(), verifiable: true });
    }
    if (out.filter((c) => c.kind === 'must_include').length >= 6) break;
  }

  // ── Must exclude ───────────────────────────────────────────────────
  const excludeRe = /\b(sin|no incluyas?|no pongas?|no menciones?|excepto|a excepci[óo]n de|salvo|without|don'?t include|do not include|exclude|except|no\s+(?:agregues|añadas))\s+([^.,;:\n]{3,60})/gi;
  let em;
  while ((em = excludeRe.exec(text)) !== null) {
    const term = clampTerm(em[2]);
    if (term && significantTokens(term).length > 0) {
      add({ kind: 'must_exclude', value: term.toLowerCase(), raw: em[0].trim(), verifiable: true });
    }
    if (out.filter((c) => c.kind === 'must_exclude').length >= 6) break;
  }

  // ── Directness (no preamble) ───────────────────────────────────────
  if (/\b(solo dame|sólo dame|just give me|directamente|sin rodeos|sin preámbulos|sin preambulos|sin introducci[óo]n|no expliques|sin explicaciones|responde directo|be direct|no preamble|just the answer|solo la respuesta|s[óo]lo la respuesta)\b/.test(lower)) {
    add({ kind: 'directness', value: 'no_preamble', raw: 'directo / sin preámbulo', verifiable: true });
  }

  // ── Tone (pre-gen hint only; not reliably verifiable) ──────────────
  m = lower.match(/\b(formal|informal|profesional|professional|t[ée]cnico|technical|sencillo|simple|casual|acad[ée]mico|academic)\b/);
  if (m) add({ kind: 'tone', value: m[1], raw: m[0], verifiable: false });

  return out.slice(0, Number(opts.maxConstraints) || 14);
}

// ── Verification ─────────────────────────────────────────────────────────────

function countParagraphs(text) {
  return String(text || '').split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean).length || (text.trim() ? 1 : 0);
}
function countWords(text) {
  const w = String(text || '').trim().match(/\p{L}[\p{L}\p{N}'-]*/gu);
  return w ? w.length : 0;
}
function countSentences(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return 0;
  const parts = s.split(/(?<=[.!?…])\s+(?=[\p{Lu}¿¡"'])/u).filter((x) => x.trim().length > 0);
  return parts.length || 1;
}
function countListItems(text) {
  const lines = String(text || '').split(/\n/);
  return lines.filter((l) => /^\s*(?:[-*•·]|\d+[.)]|[a-z][.)])\s+\S/.test(l)).length;
}

function detectLang(text) {
  const t = String(text || '').toLowerCase();
  let es = 0;
  let en = 0;
  if (/[áéíóúñ¿¡]/.test(t)) es += 3;
  if (/\b(el|la|los|las|de|que|es|son|para|pero|con|una|como|también|está|este)\b/.test(t)) es += 1;
  if (/\b(the|of|and|to|is|are|for|with|this|that|from|which|been|will)\b/.test(t)) en += 1;
  if (en > es) return 'en';
  if (es > en) return 'es';
  return 'unknown';
}

function verifyAdherence(response, constraints = [], opts = {}) {
  const text = String(response || '');
  const list = Array.isArray(constraints) ? constraints : [];
  const violations = [];
  const checked = [];

  for (const c of list) {
    if (!c || c.verifiable === false) continue;
    const v = checkOne(text, c, opts);
    if (v === null) continue; // not checkable on this response
    checked.push(c);
    if (!v.ok) violations.push({ ...c, detail: v.detail });
  }

  const score = checked.length === 0 ? 1 : 1 - violations.length / checked.length;
  return {
    satisfied: violations.length === 0,
    checked: checked.length,
    violations,
    score: Math.round(score * 100) / 100,
    fixInstruction: violations.length ? buildFixInstruction(violations) : '',
  };
}

function checkOne(text, c, opts) {
  const tolerance = Number(opts.wordTolerance) || 0.2;
  switch (c.kind) {
    case 'length_paragraphs': {
      const n = countParagraphs(text);
      if (n === 0) return null;
      return { ok: n <= c.value, detail: `tiene ${n} párrafo(s), se pidió ${c.value}` };
    }
    case 'length_sentences': {
      const n = countSentences(text);
      if (n === 0) return null;
      // allow exactly the asked count (+0 slack for 1, +1 for larger)
      const slack = c.value <= 1 ? 0 : 1;
      return { ok: n <= c.value + slack, detail: `tiene ${n} oración(es), se pidió ${c.value}` };
    }
    case 'length_words': {
      const n = countWords(text);
      if (n === 0) return null;
      if (c.op === 'max') return { ok: n <= c.value * (1 + tolerance), detail: `${n} palabras, máximo ${c.value}` };
      if (c.op === 'min') return { ok: n >= c.value * (1 - tolerance), detail: `${n} palabras, mínimo ${c.value}` };
      return { ok: Math.abs(n - c.value) <= Math.max(15, c.value * tolerance), detail: `${n} palabras, se pidió ~${c.value}` };
    }
    case 'length_items': {
      const n = countListItems(text);
      if (n === 0) return null; // no list rendered — can't reliably check
      return { ok: Math.abs(n - c.value) <= 1, detail: `${n} ítems, se pidió ${c.value}` };
    }
    case 'language': {
      const detected = detectLang(text);
      if (detected === 'unknown') return null;
      return { ok: detected === c.value, detail: `respuesta en ${detected}, se pidió ${c.value}` };
    }
    case 'must_include': {
      const toks = significantTokens(c.value);
      if (toks.length === 0) return null;
      const lower = text.toLowerCase();
      const hit = lower.includes(c.value) || toks.some((t) => lower.includes(t));
      return { ok: hit, detail: `falta: "${c.value}"` };
    }
    case 'must_exclude': {
      const toks = significantTokens(c.value);
      if (toks.length === 0) return null;
      const lower = text.toLowerCase();
      const present = lower.includes(c.value) || toks.every((t) => lower.includes(t));
      return { ok: !present, detail: `no debía aparecer: "${c.value}"` };
    }
    case 'directness': {
      const head = text.trim().slice(0, 60).toLowerCase();
      const filler = /^(claro|por supuesto|¡?claro!?|aqu[íi] tienes|aqu[íi] est[áa]|con gusto|of course|sure|certainly|here'?s|here is|great question|excelente pregunta)\b/.test(head);
      return { ok: !filler, detail: 'empieza con preámbulo/relleno' };
    }
    default:
      return null;
  }
}

function describeConstraint(c) {
  switch (c.kind) {
    case 'length_paragraphs': return `Exactamente ${c.value} párrafo${c.value > 1 ? 's' : ''}.`;
    case 'length_sentences': return `Máximo ${c.value} oración${c.value > 1 ? 'es' : ''}.`;
    case 'length_words': return c.op === 'max' ? `Máximo ${c.value} palabras.` : c.op === 'min' ? `Al menos ${c.value} palabras.` : `Alrededor de ${c.value} palabras.`;
    case 'length_items': return `Aproximadamente ${c.value} ítems en la lista.`;
    case 'language': return `Responde en ${({ es: 'español', en: 'inglés', fr: 'francés', pt: 'portugués' })[c.value] || c.value}.`;
    case 'must_include': return `DEBE incluir: ${c.value}.`;
    case 'must_exclude': return `NO debe incluir: ${c.value}.`;
    case 'directness': return 'Responde directo, sin preámbulo ni relleno.';
    case 'tone': return `Tono ${c.value}.`;
    default: return c.raw || c.kind;
  }
}

function buildConstraintPromptBlock(constraints = [], opts = {}) {
  const list = Array.isArray(constraints) ? constraints.filter(Boolean) : [];
  if (list.length === 0) return '';
  const lines = ['\n\n## REQUISITOS EXPLÍCITOS DEL USUARIO (cúmplelos TODOS, son obligatorios)'];
  for (const c of list) lines.push(`- ${describeConstraint(c)}`);
  lines.push('Antes de finalizar, verifica que tu respuesta cumple cada requisito de la lista.');
  const text = lines.join('\n');
  const max = Number(opts.maxChars) || 900;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function buildFixInstruction(violations) {
  const lines = ['\n\n<constraint_fix>', 'La respuesta anterior incumplió requisitos EXPLÍCITOS del usuario. Corrige SOLO esto y vuelve a entregar la respuesta completa:'];
  for (const v of violations.slice(0, 8)) lines.push(`  • ${describeConstraint(v)} (${v.detail})`);
  lines.push('No cambies el resto del contenido; solo ajusta para cumplir estos requisitos.');
  lines.push('</constraint_fix>');
  return lines.join('\n');
}

function summarizeForLog(result) {
  if (!result) return '[constraint-adherence] (no result)';
  const v = (result.violations || []).map((x) => x.kind).join(',') || '-';
  return `[constraint-adherence] checked=${result.checked} satisfied=${result.satisfied} score=${result.score} violations=[${v}]`;
}

module.exports = {
  extractConstraints,
  verifyAdherence,
  buildConstraintPromptBlock,
  buildFixInstruction,
  describeConstraint,
  summarizeForLog,
  // internals for tests
  countParagraphs,
  countWords,
  countSentences,
  countListItems,
  detectLang,
  significantTokens,
};
