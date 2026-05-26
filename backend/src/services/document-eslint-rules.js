'use strict';

/**
 * document-eslint-rules.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects ESLint / Prettier / Biome rule references in code comments and
 * config files:
 *
 *   - inline:    // eslint-disable-next-line no-unused-vars
 *   - block:     /* eslint-disable no-console *\/
 *   - rule names: no-unused-vars, @typescript-eslint/no-explicit-any
 *   - severity:  rules: {'no-console': 'warn'} / 'error' / 'off' / [0,1,2]
 *   - biome:     // biome-ignore lint/style/noVar
 *
 * Public API:
 *   extractEslintRules(text)             → { entries, totals, total }
 *   buildEslintRulesForFiles(files)      → { perFile, aggregate, totals }
 *   renderEslintRulesBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const DISABLE_NEXT_RE = /\/\/\s*eslint-disable-next-line\s+([@a-z][@a-z0-9/_,\s-]{2,200})/g;
const DISABLE_LINE_RE = /\/\/\s*eslint-disable-line\s+([@a-z][@a-z0-9/_,\s-]{2,200})/g;
const DISABLE_BLOCK_RE = /\/\*\s*eslint-disable\s+([@a-z][@a-z0-9/_,\s-]{2,200})\*\//g;
const RULE_CONFIG_RE = /['"](@?[a-z][a-z0-9-]{2,40}\/[a-z][a-z0-9-/]{2,60}|[a-z][a-z0-9-]{2,60})['"]?\s*:\s*['"]?(off|warn|error|0|1|2|\[)/gi;
const BIOME_RE = /\/\/\s*biome-ignore\s+(lint\/[a-z]+\/[a-zA-Z][a-zA-Z0-9]+)/g;
const PRETTIER_RE = /\/\/\s*prettier-ignore\b/g;

const RULES_RESERVED = new Set([
  'env', 'globals', 'parser', 'plugins', 'extends', 'settings', 'overrides',
  'rules', 'ignorePatterns', 'parserOptions', 'reportUnusedDisableDirectives',
]);

function splitRules(s) {
  return s.split(/[,\s]+/).map((r) => r.trim()).filter(Boolean).filter((r) => /^@?[a-z]/.test(r) && r.length >= 3);
}

function extractEslintRules(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { disableNext: 0, disableLine: 0, disableBlock: 0, config: 0, biome: 0, prettier: 0 };

  function push(kind, rule, severity) {
    const key = `${kind}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, rule, severity });
    if (totals[kind] != null) totals[kind] += 1;
  }

  DISABLE_NEXT_RE.lastIndex = 0;
  let m;
  while ((m = DISABLE_NEXT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    for (const r of splitRules(m[1])) {
      if (entries.length >= MAX_PER_FILE) break;
      push('disableNext', r, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DISABLE_LINE_RE.lastIndex = 0;
    while ((m = DISABLE_LINE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      for (const r of splitRules(m[1])) {
        if (entries.length >= MAX_PER_FILE) break;
        push('disableLine', r, null);
      }
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DISABLE_BLOCK_RE.lastIndex = 0;
    while ((m = DISABLE_BLOCK_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      for (const r of splitRules(m[1])) {
        if (entries.length >= MAX_PER_FILE) break;
        push('disableBlock', r, null);
      }
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RULE_CONFIG_RE.lastIndex = 0;
    while ((m = RULE_CONFIG_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const rule = m[1];
      if (RULES_RESERVED.has(rule)) continue;
      if (!/[-/]/.test(rule)) continue; // must look like a rule name (has hyphen or namespace slash)
      const sev = /^[012]$/.test(m[2]) ? ['off', 'warn', 'error'][parseInt(m[2], 10)] : m[2];
      push('config', rule, sev === '[' ? 'array' : sev);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    BIOME_RE.lastIndex = 0;
    while ((m = BIOME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('biome', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PRETTIER_RE.lastIndex = 0;
    while (PRETTIER_RE.exec(body) && entries.length < MAX_PER_FILE) {
      push('prettier', 'prettier-ignore', null);
      break;
    }
  }

  return { entries, totals, total: entries.length };
}

function buildEslintRulesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { disableNext: 0, disableLine: 0, disableBlock: 0, config: 0, biome: 0, prettier: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractEslintRules(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.rule}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderEslintRulesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## ESLINT / BIOME / PRETTIER RULES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 12)) {
      const sev = e.severity ? ` (${e.severity})` : '';
      lines.push(`- [${e.kind}] \`${e.rule}\`${sev}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractEslintRules,
  buildEslintRulesForFiles,
  renderEslintRulesBlock,
  _internal: { splitRules, RULES_RESERVED },
};
