'use strict';

/**
 * document-openapi-security.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects OpenAPI 3.x security configuration:
 *
 *   - components.securitySchemes:
 *     - http (bearer / basic / digest)
 *     - apiKey (in: header / query / cookie)
 *     - oauth2 (flows: authorizationCode / implicit / password / clientCredentials)
 *     - openIdConnect
 *     - mutualTLS
 *
 *   - oauth2 scopes:  scopes: { read:users: "..." }
 *   - security: [] requirements at root and per-operation level
 *   - bearerFormat / tokenUrl / authorizationUrl / openIdConnectUrl
 *
 * Public API:
 *   extractOpenapiSecurity(text)             → { entries, totals, total }
 *   buildOpenapiSecurityForFiles(files)      → { perFile, aggregate, totals }
 *   renderOpenapiSecurityBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const SCHEME_RE = /\btype\s*:\s*["']?(http|apiKey|oauth2|openIdConnect|mutualTLS)["']?/g;
const SCHEME_NAME_RE = /^[ \t]{4,}([a-zA-Z][a-zA-Z0-9_-]{0,60})\s*:\s*$/gm;
const HTTP_SCHEME_RE = /\bscheme\s*:\s*["']?(bearer|basic|digest|negotiate)["']?/g;
const BEARER_FORMAT_RE = /\bbearerFormat\s*:\s*["']?([a-zA-Z0-9._\/-]{1,40})["']?/g;
const API_KEY_IN_RE = /\bin\s*:\s*["']?(header|query|cookie)["']?\s*\n\s*name\s*:\s*["']?([a-zA-Z][a-zA-Z0-9_-]{0,60})/g;
const FLOW_RE = /\b(authorizationCode|implicit|password|clientCredentials)\s*:\s*\{|\b(authorizationCode|implicit|password|clientCredentials)\s*:\s*\n/g;
const TOKEN_URL_RE = /\b(tokenUrl|authorizationUrl|refreshUrl|openIdConnectUrl)\s*:\s*["']?(https?:\/\/[^"'\s\n]{1,200})["']?/g;
const SCOPE_RE = /^[ \t]+(read|write|admin|manage|delete|update|create|list)[:.]([a-z][a-zA-Z0-9_-]{0,40})\s*:\s*["']?([^"'\n]{1,120})/gm;
const SECURITY_REQ_RE = /^security\s*:\s*\n((?:[ \t]+-\s+[a-zA-Z][a-zA-Z0-9_-]{0,60}\s*:[^\n]{0,200}\n){1,20})/gm;

function isOpenapiLike(body) {
  return /\bsecuritySchemes?\s*:|^openapi\s*:\s*["']?3\.|^swagger\s*:\s*["']?2\./m.test(body)
    || (/securitySchemes/.test(body) && /(?:oauth2|apiKey|bearer|openIdConnect)/.test(body));
}

function extractOpenapiSecurity(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isOpenapiLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    type: 0, httpScheme: 0, bearerFormat: 0, apiKey: 0,
    flow: 0, url: 0, scope: 0, securityReq: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  SCHEME_RE.lastIndex = 0;
  let m;
  while ((m = SCHEME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('type', m[1], null);
  }
  if (entries.length < MAX_PER_FILE) {
    HTTP_SCHEME_RE.lastIndex = 0;
    while ((m = HTTP_SCHEME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('httpScheme', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    BEARER_FORMAT_RE.lastIndex = 0;
    while ((m = BEARER_FORMAT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('bearerFormat', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    API_KEY_IN_RE.lastIndex = 0;
    while ((m = API_KEY_IN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('apiKey', `${m[1]}/${m[2]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    FLOW_RE.lastIndex = 0;
    while ((m = FLOW_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('flow', m[1] || m[2], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TOKEN_URL_RE.lastIndex = 0;
    while ((m = TOKEN_URL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('url', m[1], m[2].slice(0, 80));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SCOPE_RE.lastIndex = 0;
    while ((m = SCOPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('scope', `${m[1]}:${m[2]}`, m[3].trim().slice(0, 50));
    }
  }

  let reqCount = 0;
  SECURITY_REQ_RE.lastIndex = 0;
  while (SECURITY_REQ_RE.exec(body) && reqCount < 10) reqCount += 1;
  totals.securityReq = reqCount;

  return { entries, totals, total: entries.length };
}

function buildOpenapiSecurityForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    type: 0, httpScheme: 0, bearerFormat: 0, apiKey: 0,
    flow: 0, url: 0, scope: 0, securityReq: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractOpenapiSecurity(txt);
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

function renderOpenapiSecurityBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## OPENAPI SECURITY SCHEMES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` — ${e.detail}` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractOpenapiSecurity,
  buildOpenapiSecurityForFiles,
  renderOpenapiSecurityBlock,
  _internal: { isOpenapiLike },
};
