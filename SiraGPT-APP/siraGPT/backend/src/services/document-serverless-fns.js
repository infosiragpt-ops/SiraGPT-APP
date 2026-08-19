'use strict';

/**
 * document-serverless-fns.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects serverless / function-as-a-service references:
 *
 *   - AWS Lambda:   "Lambda function FunctionName", lambda:function:Name
 *   - GCP Cloud Functions:  "Cloud Function fn-name", projects/X/locations/Y/functions/Z
 *   - GCP Cloud Run:   "Cloud Run service my-svc"
 *   - Azure Functions: "Azure Function FuncName"
 *   - Cloudflare Workers:  "Cloudflare Worker name", workers.dev URLs
 *   - Vercel/Netlify Functions: api/handler.js, function URLs
 *
 * Public API:
 *   extractServerlessFns(text)             → { entries, totals, total }
 *   buildServerlessFnsForFiles(files)      → { perFile, aggregate, totals }
 *   renderServerlessFnsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const LAMBDA_LABEL_RE = /\b(?:Lambda\s+function|AWS\s+Lambda)\s+([A-Za-z0-9_-]{2,80})/g;
const LAMBDA_PATH_RE = /\blambda(?::function)?:([A-Za-z0-9_-]{2,80})\b/gi;
const GCF_LABEL_RE = /\b(?:Cloud\s+Function|GCP\s+Function)s?\s+([A-Za-z][A-Za-z0-9-]{2,80})/g;
const GCF_PATH_RE = /\bprojects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/functions\/([A-Za-z0-9_-]{2,80})/g;
const CLOUDRUN_RE = /\bCloud\s+Run\s+(?:service|app)\s+([a-z][a-z0-9-]{2,60})/g;
const AZURE_FN_RE = /\b(?:Azure\s+Function|Azure\s+Functions\s+app)\s+([A-Za-z0-9_-]{2,80})/g;
const CF_WORKER_RE = /\b(?:Cloudflare\s+Worker|CF\s+Worker)\s+([a-z][a-z0-9-]{2,60})/g;
const WORKERS_DEV_RE = /\b([a-z0-9-]{2,60})\.workers\.dev\b/g;
const VERCEL_FN_RE = /\b(api\/[a-zA-Z0-9_./-]{2,80}\.(?:js|ts|tsx|py|go|rs))\b/g;

function extractServerlessFns(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { lambda: 0, gcf: 0, cloudRun: 0, azure: 0, cfWorker: 0, vercel: 0 };

  function push(provider, name, source) {
    const key = `${provider}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ provider, name, source });
    if (totals[provider] != null) totals[provider] += 1;
  }

  LAMBDA_LABEL_RE.lastIndex = 0;
  let m;
  while ((m = LAMBDA_LABEL_RE.exec(body)) && entries.length < MAX_PER_FILE) push('lambda', m[1], 'labeled');
  if (entries.length < MAX_PER_FILE) {
    LAMBDA_PATH_RE.lastIndex = 0;
    while ((m = LAMBDA_PATH_RE.exec(body)) && entries.length < MAX_PER_FILE) push('lambda', m[1], 'path');
  }
  if (entries.length < MAX_PER_FILE) {
    GCF_LABEL_RE.lastIndex = 0;
    while ((m = GCF_LABEL_RE.exec(body)) && entries.length < MAX_PER_FILE) push('gcf', m[1], 'labeled');
  }
  if (entries.length < MAX_PER_FILE) {
    GCF_PATH_RE.lastIndex = 0;
    while ((m = GCF_PATH_RE.exec(body)) && entries.length < MAX_PER_FILE) push('gcf', m[1], 'path');
  }
  if (entries.length < MAX_PER_FILE) {
    CLOUDRUN_RE.lastIndex = 0;
    while ((m = CLOUDRUN_RE.exec(body)) && entries.length < MAX_PER_FILE) push('cloudRun', m[1], 'labeled');
  }
  if (entries.length < MAX_PER_FILE) {
    AZURE_FN_RE.lastIndex = 0;
    while ((m = AZURE_FN_RE.exec(body)) && entries.length < MAX_PER_FILE) push('azure', m[1], 'labeled');
  }
  if (entries.length < MAX_PER_FILE) {
    CF_WORKER_RE.lastIndex = 0;
    while ((m = CF_WORKER_RE.exec(body)) && entries.length < MAX_PER_FILE) push('cfWorker', m[1], 'labeled');
    WORKERS_DEV_RE.lastIndex = 0;
    while ((m = WORKERS_DEV_RE.exec(body)) && entries.length < MAX_PER_FILE) push('cfWorker', m[1], 'workers.dev');
  }
  if (entries.length < MAX_PER_FILE) {
    VERCEL_FN_RE.lastIndex = 0;
    while ((m = VERCEL_FN_RE.exec(body)) && entries.length < MAX_PER_FILE) push('vercel', m[1], 'api-route');
  }

  return { entries, totals, total: entries.length };
}

function buildServerlessFnsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { lambda: 0, gcf: 0, cloudRun: 0, azure: 0, cfWorker: 0, vercel: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractServerlessFns(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.provider}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.provider] != null) totals[e.provider] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderServerlessFnsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## SERVERLESS / FAAS REFERENCES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- ${e.provider}: \`${e.name}\` (${e.source})`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractServerlessFns,
  buildServerlessFnsForFiles,
  renderServerlessFnsBlock,
};
