'use strict';

/**
 * document-i18n-keys.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects internationalisation string keys from common SDK patterns:
 *
 *   - i18next:     t('common.save') | t('user.profile.title')
 *   - react-i18n:  useTranslation().t('foo.bar')
 *   - Vue i18n:    $t('foo.bar') | {{ $t('foo.bar') }}
 *   - Rails:       I18n.t('users.create.success')
 *   - Angular:     {{ 'foo.bar' | translate }}
 *   - FormatJS:    intl.formatMessage({ id: 'foo.bar', defaultMessage: 'X' })
 *
 * Public API:
 *   extractI18nKeys(text)             → { entries, totals, total }
 *   buildI18nKeysForFiles(files)      → { perFile, aggregate, totals }
 *   renderI18nKeysBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 4800;

const T_CALL_RE = /\b(?:I18n\.t|i18n\.t|intl\.formatMessage|\$t|t)\s*\(\s*['"`]([a-zA-Z][a-zA-Z0-9_.-]{1,80})['"`]/g;
const FORMATJS_ID_RE = /\bid\s*:\s*['"`]([a-zA-Z][a-zA-Z0-9_.-]{1,80})['"`]\s*,\s*(?:defaultMessage|description)/g;
const ANGULAR_PIPE_RE = /['"`]([a-zA-Z][a-zA-Z0-9_.-]{2,80})['"`]\s*\|\s*translate\b/g;
const USE_TRANSLATION_RE = /useTranslation\s*\(\s*['"`]([a-zA-Z][a-zA-Z0-9_.-]{1,80})['"`]\s*\)/g;

function looksLikeI18nKey(s) {
  if (!s || s.length < 2 || s.length > 80) return false;
  // Must have at least one dot, hyphen, or underscore (typical i18n keys are dotted)
  if (!/[.\-_]/.test(s)) return false;
  // Reject pure-numeric or starting with digit
  if (/^\d/.test(s)) return false;
  // Reject sentence-like content (spaces, capital letters near start without dot)
  if (/\s/.test(s)) return false;
  return true;
}

function namespaceOf(key) {
  const idx = key.indexOf('.');
  return idx >= 0 ? key.slice(0, idx) : '';
}

function extractI18nKeys(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  function push(key, source) {
    if (!looksLikeI18nKey(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    const ns = namespaceOf(key);
    entries.push({ key, namespace: ns, source });
    if (ns) totals[ns] = (totals[ns] || 0) + 1;
  }

  T_CALL_RE.lastIndex = 0;
  let m;
  while ((m = T_CALL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push(m[1], 't-call');
  }
  if (entries.length < MAX_PER_FILE) {
    FORMATJS_ID_RE.lastIndex = 0;
    while ((m = FORMATJS_ID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'formatjs');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ANGULAR_PIPE_RE.lastIndex = 0;
    while ((m = ANGULAR_PIPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'angular-pipe');
    }
  }
  if (entries.length < MAX_PER_FILE) {
    USE_TRANSLATION_RE.lastIndex = 0;
    while ((m = USE_TRANSLATION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push(m[1], 'use-translation');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildI18nKeysForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractI18nKeys(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      if (aggSeen.has(e.key)) continue;
      aggSeen.add(e.key);
      aggregate.push(e);
      if (e.namespace) totals[e.namespace] = (totals[e.namespace] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderI18nKeysBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## I18N KEYS'];
  const t = report.totals || {};
  const entries = Object.entries(t).sort(([, a], [, b]) => b - a).slice(0, 8);
  if (entries.length) {
    lines.push(`- Top namespaces: ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  }
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- \`${e.key}\` (${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractI18nKeys,
  buildI18nKeysForFiles,
  renderI18nKeysBlock,
  _internal: { looksLikeI18nKey, namespaceOf },
};
