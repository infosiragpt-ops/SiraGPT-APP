'use strict';

/**
 * document-iso-langs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects ISO 639-1 / BCP-47 language identifiers in headers, code, config:
 *
 *   - bare 2-letter:  en / es / fr / de
 *   - BCP-47:         en-US / es-MX / pt-BR / zh-CN / zh-Hans-CN
 *   - 3-letter:       eng / spa / fra (ISO 639-2/B and 639-2/T)
 *   - labeled:        "language: en", "lang=es"
 *
 * Public API:
 *   extractIsoLangs(text)             → { entries, totals, total }
 *   buildIsoLangsForFiles(files)      → { perFile, aggregate, totals }
 *   renderIsoLangsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const ISO_639_1 = new Set([
  'aa', 'ab', 'ae', 'af', 'ak', 'am', 'an', 'ar', 'as', 'av', 'ay', 'az',
  'ba', 'be', 'bg', 'bh', 'bi', 'bm', 'bn', 'bo', 'br', 'bs',
  'ca', 'ce', 'ch', 'co', 'cr', 'cs', 'cu', 'cv', 'cy',
  'da', 'de', 'dv', 'dz',
  'ee', 'el', 'en', 'eo', 'es', 'et', 'eu',
  'fa', 'ff', 'fi', 'fj', 'fo', 'fr', 'fy',
  'ga', 'gd', 'gl', 'gn', 'gu', 'gv',
  'ha', 'he', 'hi', 'ho', 'hr', 'ht', 'hu', 'hy', 'hz',
  'ia', 'id', 'ie', 'ig', 'ii', 'ik', 'io', 'is', 'it', 'iu',
  'ja', 'jv',
  'ka', 'kg', 'ki', 'kj', 'kk', 'kl', 'km', 'kn', 'ko', 'kr', 'ks', 'ku', 'kv', 'kw', 'ky',
  'la', 'lb', 'lg', 'li', 'ln', 'lo', 'lt', 'lu', 'lv',
  'mg', 'mh', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my',
  'na', 'nb', 'nd', 'ne', 'ng', 'nl', 'nn', 'no', 'nr', 'nv', 'ny',
  'oc', 'oj', 'om', 'or', 'os',
  'pa', 'pi', 'pl', 'ps', 'pt',
  'qu',
  'rm', 'rn', 'ro', 'ru', 'rw',
  'sa', 'sc', 'sd', 'se', 'sg', 'si', 'sk', 'sl', 'sm', 'sn', 'so', 'sq', 'sr', 'ss', 'st', 'su', 'sv', 'sw',
  'ta', 'te', 'tg', 'th', 'ti', 'tk', 'tl', 'tn', 'to', 'tr', 'ts', 'tt', 'tw', 'ty',
  'ug', 'uk', 'ur', 'uz',
  've', 'vi', 'vo',
  'wa', 'wo',
  'xh',
  'yi', 'yo',
  'za', 'zh', 'zu',
]);

const BCP47_RE = /(?<![A-Za-z0-9])([a-z]{2,3})(?:-([A-Z][a-z]{3}))?(?:-([A-Z]{2}|\d{3}))?(?![A-Za-z0-9])/g;
const LABELED_RE = /\b(?:language|lang|locale|content-language)\s*[:=]\s*"?([a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?)\b/gi;

function looksLikeLang(s) {
  if (!s) return false;
  const lower = s.toLowerCase();
  const primary = lower.split('-')[0];
  if (primary.length === 2 && ISO_639_1.has(primary)) return true;
  // 3-letter codes — accept conservatively
  return false;
}

function extractIsoLangs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { bare: 0, region: 0, script: 0, labeled: 0 };

  function push(lang, source, kind) {
    const key = `${lang}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ lang, source, kind });
    if (totals[kind] != null) totals[kind] += 1;
  }

  // Labeled (preferred)
  LABELED_RE.lastIndex = 0;
  let m;
  while ((m = LABELED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const lang = m[1];
    if (!looksLikeLang(lang)) continue;
    const kind = lang.includes('-') ? (lang.split('-').length === 3 ? 'script' : 'region') : 'bare';
    push(lang, 'labeled', kind === 'bare' ? 'labeled' : kind);
  }

  // BCP-47 with region tag
  if (entries.length < MAX_PER_FILE) {
    BCP47_RE.lastIndex = 0;
    while ((m = BCP47_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const lang = m[0];
      if (!m[2] && !m[3]) continue; // Need region or script suffix to qualify here
      if (!looksLikeLang(lang)) continue;
      const kind = m[2] ? 'script' : 'region';
      push(lang, 'bcp47', kind);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildIsoLangsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { bare: 0, region: 0, script: 0, labeled: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractIsoLangs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.lang)) continue;
      aggSeen.add(e.lang);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderIsoLangsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## ISO LANGUAGE TAGS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- ${e.lang} (${e.source}, ${e.kind})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractIsoLangs,
  buildIsoLangsForFiles,
  renderIsoLangsBlock,
  _internal: { looksLikeLang, ISO_639_1 },
};
