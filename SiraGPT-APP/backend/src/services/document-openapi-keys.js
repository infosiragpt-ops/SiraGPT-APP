'use strict';

/**
 * document-openapi-keys.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects OpenAPI / Swagger specification metadata: spec version, info.title,
 * paths, operationIds, $ref schemas, security schemes.
 *
 *   - openapi: 3.0.3 / swagger: "2.0"
 *   - paths: /users/{id} / operationId: getUser
 *   - $ref: '#/components/schemas/X'
 *   - security: bearerAuth / apiKey / oauth2 / openIdConnect
 *
 * Public API:
 *   extractOpenapiKeys(text)             → { entries, totals, total }
 *   buildOpenapiKeysForFiles(files)      → { perFile, aggregate, totals }
 *   renderOpenapiKeysBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 80_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const VERSION_RE = /\b(openapi|swagger)\s*:\s*["']?(\d+(?:\.\d+){0,2})["']?/gi;
const INFO_TITLE_RE = /\binfo\s*:[\s\S]{0,100}?\btitle\s*:\s*["']?([^"'\n]{2,80})["']?/i;
const PATH_RE = /^\s+(\/[a-zA-Z0-9_\-/{}.]{1,150})\s*:\s*$/gm;
const OPERATION_ID_RE = /\boperationId\s*:\s*["']?([A-Za-z][A-Za-z0-9_-]{1,80})["']?/g;
const REF_RE = /\$ref\s*:\s*["']?(#\/(?:components|definitions)\/[A-Za-z][A-Za-z0-9_/]{2,80})["']?/g;
const SECURITY_TYPE_RE = /\btype\s*:\s*["']?(apiKey|http|oauth2|openIdConnect|mutualTLS)["']?/g;

function extractOpenapiKeys(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { version: 0, info: 0, path: 0, operation: 0, ref: 0, security: 0 };

  function push(kind, name) {
    const key = `${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, name });
    if (totals[kind] != null) totals[kind] += 1;
  }

  VERSION_RE.lastIndex = 0;
  let m;
  while ((m = VERSION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('version', `${m[1]}=${m[2]}`);
  }

  const titleMatch = INFO_TITLE_RE.exec(body);
  if (titleMatch) push('info', `title: ${titleMatch[1].slice(0, 50)}`);

  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('path', m[1]);
  }

  if (entries.length < MAX_PER_FILE) {
    OPERATION_ID_RE.lastIndex = 0;
    while ((m = OPERATION_ID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('operation', m[1]);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('ref', m[1]);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    SECURITY_TYPE_RE.lastIndex = 0;
    while ((m = SECURITY_TYPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('security', m[1]);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildOpenapiKeysForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { version: 0, info: 0, path: 0, operation: 0, ref: 0, security: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractOpenapiKeys(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
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

function renderOpenapiKeysBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## OPENAPI / SWAGGER SPEC KEYS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 12)) {
      lines.push(`- [${e.kind}] \`${e.name}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractOpenapiKeys,
  buildOpenapiKeysForFiles,
  renderOpenapiKeysBlock,
};
