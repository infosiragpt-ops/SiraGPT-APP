'use strict';

/**
 * document-env-vars.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects environment-variable / config-flag references in technical docs:
 *
 *   - SCREAMING_SNAKE_CASE tokens with at least one underscore (DATABASE_URL,
 *     STRIPE_API_KEY, FEATURE_FLAG_X) — possibly prefixed by export, $, or
 *     process.env., os.environ.get, env., %, or {{}}
 *   - .env-style declarations: FOO_BAR=value
 *   - Default-value lines: "DEFAULT_FOO: 5" / "Default: 5"
 *
 * Output groups by token name, dedupes, and notes if a default value
 * is observable. Routes "what env vars does this need?", "what config
 * does it expect?" to a citeable inventory. Different from
 * document-api-endpoints (API surface) and document-identifiers
 * (ISBN/DOI/etc.).
 *
 * Public API:
 *   extractEnvVars(text)          → EnvReport
 *   buildEnvVarsForFiles(files)   → { perFile, aggregate, totals }
 *   renderEnvVarsBlock(report)    → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 90_000;
const MAX_PER_FILE = 32;
const MAX_AGGREGATE = 40;
const MAX_BLOCK_CHARS = 6000;
const MAX_VALUE_LEN = 80;

// Reject common non-env all-caps tokens
const STOPWORDS = new Set([
  'README', 'LICENSE', 'TODO', 'FIXME', 'NOTE', 'BUG', 'HACK', 'XXX',
  'HTTP', 'HTTPS', 'JSON', 'YAML', 'TOML', 'XML', 'CSV', 'TSV', 'PDF',
  'API', 'CLI', 'SDK', 'IDE', 'CPU', 'GPU', 'RAM', 'SSD', 'HDD', 'USB',
  'DNS', 'IP', 'URL', 'URI', 'UUID', 'MAC', 'SQL', 'NoSQL',
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE',
  'AND', 'OR', 'NOT', 'XOR', 'IF', 'ELSE', 'FOR', 'WHILE', 'BREAK', 'CONTINUE', 'RETURN',
  'NULL', 'TRUE', 'FALSE', 'UNDEFINED', 'NAN', 'INFINITY',
  'OK', 'OKAY', 'YES', 'NO', 'ON', 'OFF', 'AC', 'PR',
  'RFC', 'CVE', 'PMID', 'DOI', 'ISBN', 'ARN',
  'BACKLOG', 'DONE', 'WONTFIX',
]);

// Inline: prefixed forms ($FOO, process.env.FOO, env.FOO, ${FOO}, %FOO%)
const PREFIXED_RE = /(?:\$|process\.env\.|os\.environ\.get\(['"]?|env\.|env\[['"]|\$\{|%)\s*([A-Z][A-Z0-9_]*[A-Z0-9])/g;

// Bare SCREAMING_SNAKE_CASE with at least one underscore
const BARE_RE = /(?:^|[\s`'"<>(\[])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?=[\s`'"<>):,;!?]|$)/g;

// .env-style declaration: FOO=value
const ENV_DECLARATION_RE = /^[\t ]*(?:export\s+)?([A-Z][A-Z0-9_]*[A-Z0-9])\s*=\s*([^\n]*)$/gim;

function safeText(v) { return typeof v === 'string' ? v : ''; }

function safeFileName(file) {
  if (!file) return 'attachment';
  return file.name || file.originalName || file.id || 'attachment';
}

function clipValue(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (s.length <= MAX_VALUE_LEN) return s;
  return `${s.slice(0, MAX_VALUE_LEN - 1)}…`;
}

function isLikelyEnvName(token) {
  if (!token || token.length < 3) return false;
  if (STOPWORDS.has(token)) return false;
  if (!/_/.test(token)) return false; // require at least one underscore
  if (!/[A-Z]/.test(token)) return false;
  return /^[A-Z][A-Z0-9_]*[A-Z0-9]$/.test(token);
}

function extractEnvVars(input) {
  const text = safeText(input);
  if (!text) return { vars: [], total: 0, totals: { withDefault: 0, withoutDefault: 0 }, truncated: false };
  const head = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const map = new Map();

  function add(name, defaultValue, source) {
    if (!isLikelyEnvName(name)) return;
    if (map.size >= MAX_PER_FILE && !map.has(name)) return;
    const existing = map.get(name);
    if (existing) {
      if (!existing.defaultValue && defaultValue) existing.defaultValue = clipValue(defaultValue);
      existing.sources.add(source);
    } else {
      map.set(name, {
        name,
        defaultValue: defaultValue ? clipValue(defaultValue) : null,
        sources: new Set([source]),
      });
    }
  }

  for (const m of head.matchAll(PREFIXED_RE)) add(m[1], null, 'prefixed');
  for (const m of head.matchAll(BARE_RE)) add(m[1], null, 'bare');
  for (const m of head.matchAll(ENV_DECLARATION_RE)) add(m[1], m[2] ? m[2].trim() : null, 'declaration');

  const vars = Array.from(map.values()).map((v) => ({
    name: v.name,
    defaultValue: v.defaultValue,
    sources: Array.from(v.sources),
  }));
  const totals = {
    withDefault: vars.filter((v) => v.defaultValue !== null).length,
    withoutDefault: vars.filter((v) => v.defaultValue === null).length,
  };
  return { vars, total: vars.length, totals, truncated: text.length > SCAN_HEAD_BYTES };
}

function buildEnvVarsForFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const perFile = [];
  let aggregate = [];
  const totals = { withDefault: 0, withoutDefault: 0 };
  for (const f of list) {
    const r = extractEnvVars(safeText(f.extractedText));
    if (r.total === 0) continue;
    const name = safeFileName(f);
    perFile.push({ file: name, vars: r.vars, totals: r.totals });
    aggregate = aggregate.concat(r.vars.map((v) => ({ ...v, file: name })));
    totals.withDefault += r.totals.withDefault;
    totals.withoutDefault += r.totals.withoutDefault;
  }
  aggregate = aggregate.slice(0, MAX_AGGREGATE);
  return { perFile, aggregate, totals };
}

function renderVar(v, opts = {}) {
  const file = opts.includeFile && v.file ? ` _(${v.file})_` : '';
  const dv = v.defaultValue ? ` = \`${v.defaultValue}\`` : '';
  return `- \`${v.name}\`${dv}${file}`;
}

function renderEnvVarsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const totals = report.totals || { withDefault: 0, withoutDefault: 0 };
  const heading = `## ENVIRONMENT VARIABLES / CONFIG FLAGS
SCREAMING_SNAKE_CASE tokens detected as environment variables / config flags — bare references (e.g. \`DATABASE_URL\`), prefixed mentions (\`$FOO\`, \`process.env.FOO\`, \`os.environ.get('FOO')\`, \`env.FOO\`, \`\${FOO}\`, \`%FOO%\`), and .env-style declarations (\`FOO=value\`). Tokens require at least one underscore and pass a stopword filter (common acronyms like API/CLI/JSON are excluded). Routes "what env vars does this need?" / "what config does it expect?" to a citeable inventory.

**Totals:** withDefault=${totals.withDefault}  withoutDefault=${totals.withoutDefault}`;
  const sections = [];
  if (report.perFile.length === 1) {
    const only = report.perFile[0];
    sections.push(`### File: ${only.file}`);
    for (const v of only.vars) sections.push(renderVar(v));
  } else {
    sections.push('### Aggregate env vars across all files');
    for (const v of report.aggregate) sections.push(renderVar(v, { includeFile: true }));
    for (const p of report.perFile) {
      sections.push(`\n### File: ${p.file}`);
      for (const v of p.vars) sections.push(renderVar(v));
    }
  }
  let combined = `${heading}\n\n${sections.join('\n')}`;
  if (combined.length > MAX_BLOCK_CHARS) {
    combined = `${combined.slice(0, MAX_BLOCK_CHARS - 80)}\n\n[...env vars block truncated to stay within token budget]`;
  }
  return combined;
}

module.exports = {
  extractEnvVars,
  buildEnvVarsForFiles,
  renderEnvVarsBlock,
  _internal: {
    PREFIXED_RE,
    BARE_RE,
    ENV_DECLARATION_RE,
    STOPWORDS,
    isLikelyEnvName,
  },
};
