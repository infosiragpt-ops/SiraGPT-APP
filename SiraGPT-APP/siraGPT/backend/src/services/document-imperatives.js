'use strict';

/**
 * document-imperatives.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects imperative sentences (commands/instructions) common in tutorials,
 * runbooks, README setup steps:
 *
 *   - Verb-first imperative: "Install dependencies", "Run npm test"
 *   - Numbered/bulleted instructions: "1. Click Save", "- Edit config"
 *   - Strong directives: "Make sure to X", "Be sure to Y"
 *   - Negatives: "Don't commit secrets", "Avoid using X"
 *   - Spanish: "Instale las dependencias", "Ejecute npm test", "No
 *     comparta credenciales"
 *
 * Uses a curated verb whitelist to reduce false positives. Routes
 * "what should I do?" / "next steps?" to a citeable list.
 *
 * Public API:
 *   extractImperatives(text)         → ImperativeReport
 *   buildImperativesForFiles(files)  → { perFile, aggregate }
 *   renderImperativesBlock(report)   → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;
const MAX_TEXT_LEN = 200;

const ACTION_VERBS_EN = [
  'install', 'run', 'execute', 'create', 'add', 'remove', 'delete', 'update',
  'edit', 'modify', 'configure', 'set', 'check', 'verify', 'test', 'deploy',
  'build', 'compile', 'push', 'pull', 'clone', 'commit', 'merge', 'use',
  'click', 'open', 'close', 'save', 'enable', 'disable', 'restart', 'stop',
  'start', 'launch', 'navigate', 'visit', 'replace', 'rename', 'copy', 'move',
  'paste', 'load', 'unload', 'mount', 'unmount', 'apply', 'rollback', 'revert',
  'ensure', 'make', 'allow', 'avoid', 'do', "don't", 'do not', 'never',
  'always', 'note', 'remember', 'consider', 'review', 'submit', 'send',
  'fetch', 'download', 'upload', 'restore', 'backup',
];

const ACTION_VERBS_ES = [
  'instale', 'ejecute', 'cree', 'a[ñn]ada', 'agregue', 'elimine', 'actualice',
  'edite', 'modifique', 'configure', 'establezca', 'verifique', 'pruebe',
  'despliegue', 'compile', 'empuje', 'haga', 'use', 'utilice', 'haga\\s+clic',
  'abra', 'cierre', 'guarde', 'active', 'desactive', 'reinicie', 'pare',
  'inicie', 'lance', 'navegue', 'visite', 'reemplace', 'renombre', 'copie',
  'mueva', 'pegue', 'cargue', 'monte', 'aplique', 'asegure', 'evite', 'no\\s+\\w+',
  'recuerde', 'considere', 'revise', 'env[íi]e', 'descargue', 'cargue', 'restaure',
];

const IMPERATIVE_RE_EN = new RegExp(`(?:^|\\n)\\s*(?:[-*+]|\\d+[.)])?\\s*((?:${ACTION_VERBS_EN.join('|')})\\b[^.!?\\n]{4,200}[.!]?)`, 'gim');
const IMPERATIVE_RE_ES = new RegExp(`(?:^|\\n)\\s*(?:[-*+]|\\d+[.)])?\\s*((?:${ACTION_VERBS_ES.join('|')})\\b[^.!?\\n]{4,200}[.!]?)`, 'gimu');

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipText(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_TEXT_LEN) return t;
  return `${t.slice(0, MAX_TEXT_LEN - 1)}…`;
}

function extractImperatives(input) {
  const text = safeText(input);
  if (!text) return { imperatives: [], total: 0, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const imperatives = [];
  const seen = new Set();

  function add(text, lang) {
    if (imperatives.length >= MAX_PER_FILE) return;
    const t = clipText(text);
    if (!t) return;
    const key = t.toLowerCase().slice(0, 80);
    if (seen.has(key)) return;
    seen.add(key);
    imperatives.push({ text: t, lang });
  }

  for (const m of head.matchAll(IMPERATIVE_RE_EN)) add(m[1], 'en');
  for (const m of head.matchAll(IMPERATIVE_RE_ES)) add(m[1], 'es');

  return { imperatives, total: imperatives.length, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildImperativesForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  for (const f of list) {
    const r = extractImperatives(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, imperatives: r.imperatives });
    aggregate = aggregate.concat(r.imperatives.map((i) => ({ ...i, file: name })));
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate };
}

function renderImperative(i, opts = {}) {
  const file = opts.includeFile && i.file ? ` _(${i.file})_` : '';
  return `- [${i.lang}]${file} ${i.text}`;
}

function renderImperativesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const heading = `## IMPERATIVES / INSTRUCTIONS
Imperative sentences (commands/instructions) detected via curated action-verb whitelist — install/run/create/edit/configure/check/verify/deploy/build/use/click/open/save (English) and instale/ejecute/cree/edite/configure/verifique/despliegue/use (Spanish). Captures verb-first sentences plus numbered/bulleted instructions. Routes "what should I do?" / "next steps?" to a citeable list.`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const i of only.imperatives) sections.push(renderImperative(i));
  } else {
    sections.push('### Aggregate imperatives across all files');
    for (const i of report.aggregate) sections.push(renderImperative(i, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const i of p.imperatives) sections.push(renderImperative(i));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...imperatives block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractImperatives,
  buildImperativesForFiles,
  renderImperativesBlock,
  _internal: {
    IMPERATIVE_RE_EN,
    IMPERATIVE_RE_ES,
    ACTION_VERBS_EN,
    ACTION_VERBS_ES,
  },
};
