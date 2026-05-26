'use strict';

/**
 * document-env-names.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects deployment-environment labels (prod / staging / dev / qa / sandbox)
 * with context-aware matching. Distinguishes between:
 *
 *   - labeled:   "environment: production", "ENV=staging", "stage: prod"
 *   - hostname:  "api.staging.example.com", "qa.internal", "prod-cluster-1"
 *   - keyword:   "in production", "deployed to staging"
 *
 * Public API:
 *   extractEnvNames(text)            → { entries, totals, total }
 *   buildEnvNamesForFiles(files)     → { perFile, aggregate, totals }
 *   renderEnvNamesBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const CANONICAL = {
  prod: 'production',
  production: 'production',
  prd: 'production',
  staging: 'staging',
  stg: 'staging',
  stage: 'staging',
  dev: 'development',
  development: 'development',
  develop: 'development',
  qa: 'qa',
  test: 'test',
  testing: 'test',
  sandbox: 'sandbox',
  sbx: 'sandbox',
  uat: 'uat',
  preview: 'preview',
  preprod: 'preprod',
  'pre-prod': 'preprod',
  'pre-production': 'preprod',
  canary: 'canary',
  edge: 'edge',
  local: 'local',
};

const KEYWORDS = Object.keys(CANONICAL).sort((a, b) => b.length - a.length);
const KW_ALT = KEYWORDS.map((k) => k.replace(/[-]/g, '[-]')).join('|');

const LABELED_RE = new RegExp(`\\b(?:env(?:ironment)?|stage|tier|deployment|profile)\\s*[:=]\\s*"?(${KW_ALT})\\b`, 'gi');
const ENV_VAR_RE = new RegExp(`\\b(?:NODE_ENV|RAILS_ENV|FLASK_ENV|DEPLOY_ENV|APP_ENV|ENVIRONMENT|ENV)\\s*=\\s*"?(${KW_ALT})\\b`, 'gi');
const HOSTNAME_RE = new RegExp(`\\b(?:api|app|admin|www|web|svc|svc-[a-z0-9]+)\\.(${KW_ALT})\\.[a-z0-9.-]{2,40}`, 'gi');
const PREFIXED_HOST_RE = new RegExp(`\\b(${KW_ALT})-[a-z][a-z0-9-]{2,30}\\b`, 'gi');

function extractEnvNames(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = {};

  function push(env, source, ctx) {
    const can = CANONICAL[env.toLowerCase()] || env.toLowerCase();
    const key = `${can}:${source}:${ctx}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ env: can, source, context: ctx });
    totals[can] = (totals[can] || 0) + 1;
  }

  LABELED_RE.lastIndex = 0;
  let m;
  while ((m = LABELED_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push(m[1], 'labeled', m[0].slice(0, 60));
  }
  ENV_VAR_RE.lastIndex = 0;
  while ((m = ENV_VAR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push(m[1], 'env-var', m[0].slice(0, 60));
  }
  HOSTNAME_RE.lastIndex = 0;
  while ((m = HOSTNAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push(m[1], 'hostname', m[0].slice(0, 60));
  }
  PREFIXED_HOST_RE.lastIndex = 0;
  while ((m = PREFIXED_HOST_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push(m[1], 'prefix', m[0].slice(0, 60));
  }

  return { entries, totals, total: entries.length };
}

function buildEnvNamesForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {};
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractEnvNames(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.env}:${e.source}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      totals[e.env] = (totals[e.env] || 0) + 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderEnvNamesBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## DEPLOYMENT ENVIRONMENTS'];
  const t = report.totals || {};
  const parts = Object.keys(t).map((k) => `${k}: ${t[k]}`).slice(0, 8);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.env} (${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractEnvNames,
  buildEnvNamesForFiles,
  renderEnvNamesBlock,
  _internal: { CANONICAL },
};
