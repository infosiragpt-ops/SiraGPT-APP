'use strict';

/**
 * document-call-to-action.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects CALL-TO-ACTION (CTA) sentences in marketing / sales /
 * communication documents — "Sign up now", "Click here", "Reserva tu
 * lugar", "Suscríbete". Helps the chat answer "what is the document
 * asking the reader to do?" without inference.
 *
 * Different from document-obligations-extractor (binding shall /
 * must), document-recommendations (we suggest …): CTAs target the
 * READER and use imperatives.
 *
 * Coverage (deterministic, bilingual, < 12 ms on 1 MB):
 *
 *   - English imperatives: sign up / sign in / subscribe / click /
 *     join / try / start / register / book / reserve / download /
 *     get started / contact us / learn more / read more.
 *   - Spanish imperatives: regístrate / suscríbete / haz clic / únete /
 *     prueba / empieza / reserva / descarga / contáctanos / saber más.
 *   - Marketing-urgent qualifiers: now / today / limited time /
 *     ahora / hoy / por tiempo limitado.
 *
 * Public API:
 *   extractCTAs(text)                  → CTAReport
 *   buildCTAsForFiles(files)           → { perFile, aggregate }
 *   renderCTAsBlock(report)            → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4000;
const MIN_SENTENCE_LEN = 8;
const MAX_SENTENCE_LEN = 220;

const CTA_PATTERNS_EN = [
  /\b(sign\s+up|sign\s+in|subscribe|register|join|click|tap|book|reserve|download|get\s+started|start\s+(?:now|today)|try\s+(?:it\s+)?(?:free|now)|contact\s+us|learn\s+more|read\s+more|buy\s+now|order\s+now|shop\s+now|see\s+(?:more|details)|request\s+(?:a\s+)?demo)\b/i,
];

const CTA_PATTERNS_ES = [
  /(?:^|[^\p{L}])(reg[ií]strate|reg[íi]strese|suscr[íi]bete|haz\s+(?:clic|click)|[uú]nete|prueba(?:lo)?|empieza|reserva|descarga|cont[áa]ctanos|cont[áa]ctenos|saber\s+m[áa]s|leer\s+m[áa]s|comprar\s+(?:ahora|ya)|pedir\s+(?:ahora|ya)|comprar\s+hoy|solicita\s+(?:una\s+)?demo)(?=[^\p{L}]|$)/iu,
];

const URGENCY_PATTERNS = [
  /\b(now|today|right\s+away|limited\s+time|don't\s+miss|hurry|act\s+fast)\b/i,
  /(?:^|[^\p{L}])(ahora|hoy|cuanto\s+antes|por\s+tiempo\s+limitado|no\s+lo\s+pierdas|date\s+prisa|act[uú]a\s+r[áa]pido)(?=[^\p{L}]|$)/iu,
];

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clip(text, max = MAX_SENTENCE_LEN) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?。！？])\s+(?=[A-ZÁÉÍÓÚÑ\d"'¿¡(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LEN);
}

function isCTA(sentence) {
  for (const re of CTA_PATTERNS_EN) if (re.test(sentence)) return true;
  for (const re of CTA_PATTERNS_ES) if (re.test(sentence)) return true;
  return false;
}

function hasUrgency(sentence) {
  for (const re of URGENCY_PATTERNS) if (re.test(sentence)) return true;
  return false;
}

function extractCTAs(input) {
  const text = safeText(input);
  if (!text) return { ctas: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const sentences = splitSentences(head);
  const ctas = [];
  const seen = new Set();
  for (const s of sentences) {
    if (ctas.length >= MAX_PER_FILE) break;
    if (!isCTA(s)) continue;
    const clipped = clip(s);
    const key = clipped.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    ctas.push({ sentence: clipped, urgent: hasUrgency(s) });
  }
  return { ctas, total: ctas.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildCTAsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractCTAs(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, ctas: r.ctas });
    aggregate = aggregate.concat(r.ctas.map((c) => ({ ...c, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderLine(c, opts = {}) {
  const tag = c.urgent ? 'URGENT-CTA' : 'CTA';
  const file = opts.includeFile && c.file ? ` _(${c.file})_` : '';
  return `- [**${tag}**]${file} ${c.sentence}`;
}

function renderCTAsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## CALLS TO ACTION
Imperative reader-directed sentences surfaced from the attached document(s) — sign-up / subscribe / click / register / try / buy / learn-more verbs, with the urgency tag set when "now / today / limited time / ahora / hoy / por tiempo limitado" qualifiers are present. Use this block to answer "what does the document ask the reader to do?" / "what's the conversion goal?".`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const c of only.ctas) sections.push(renderLine(c));
  } else {
    sections.push('### Aggregate CTAs across all files');
    for (const c of report.aggregate) sections.push(renderLine(c, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const c of p.ctas) sections.push(renderLine(c));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...CTA block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractCTAs,
  buildCTAsForFiles,
  renderCTAsBlock,
  _internal: {
    splitSentences,
    isCTA,
    hasUrgency,
    CTA_PATTERNS_EN,
    CTA_PATTERNS_ES,
    URGENCY_PATTERNS,
  },
};
