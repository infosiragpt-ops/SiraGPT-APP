'use strict';

/**
 * document-jwt-claims.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects JWT (JSON Web Token) claim references in decoded-payload JSON or
 * code accessing `payload.X`:
 *
 *   - Registered claims:  iss / sub / aud / exp / nbf / iat / jti
 *   - Common claims:      scope / scp / roles / permissions / email / preferred_username
 *   - OIDC claims:        name / given_name / family_name / picture / locale / email_verified
 *   - Custom claims:      tenant_id / org_id / azp / amr / acr / sid
 *
 * Public API:
 *   extractJwtClaims(text)             → { entries, totals, total }
 *   buildJwtClaimsForFiles(files)      → { perFile, aggregate, totals }
 *   renderJwtClaimsBlock(report)       → markdown string ('' OK)
 *
 * NOTE: Claim VALUES are partially masked — only the field NAME and a short
 * length/preview is emitted, never the full token data.
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 20;
const MAX_AGGREGATE = 26;
const MAX_BLOCK_CHARS = 4800;

const REGISTERED = new Set(['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti']);
const OIDC = new Set([
  'name', 'given_name', 'family_name', 'middle_name', 'nickname',
  'preferred_username', 'profile', 'picture', 'website', 'email',
  'email_verified', 'gender', 'birthdate', 'zoneinfo', 'locale',
  'phone_number', 'phone_number_verified', 'address', 'updated_at',
]);
const COMMON = new Set([
  'scope', 'scp', 'roles', 'permissions', 'azp', 'amr', 'acr', 'sid',
  'tenant_id', 'org_id', 'tid', 'oid', 'client_id', 'cnf',
]);

const JSON_FIELD_RE = /"(iss|sub|aud|exp|nbf|iat|jti|scope|scp|roles|permissions|azp|amr|acr|sid|tenant_id|org_id|tid|oid|client_id|cnf|name|given_name|family_name|middle_name|nickname|preferred_username|profile|picture|website|email|email_verified|gender|birthdate|zoneinfo|locale|phone_number|phone_number_verified|address|updated_at)"\s*:\s*("(?:[^"\\\n]|\\.){0,200}"|\d+(?:\.\d+)?|true|false|null|\[[^\]]{0,200}\])/g;
const PAYLOAD_ACCESS_RE = /\b(?:payload|claims|jwt|token|decoded)\.([a-z][a-z0-9_]{0,40})/gi;
const JWT_HEADER_RE = /\beyJ[A-Za-z0-9_-]{8,40}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;

function classifyClaim(name) {
  if (REGISTERED.has(name)) return 'registered';
  if (OIDC.has(name)) return 'oidc';
  if (COMMON.has(name)) return 'common';
  return 'custom';
}

function previewValue(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (s.length <= 24) return s;
  return `${s.slice(0, 12)}…${s.slice(-6)}`;
}

function extractJwtClaims(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { registered: 0, oidc: 0, common: 0, custom: 0, tokens: 0 };

  function push(claim, category, preview) {
    const key = `${category}:${claim}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ claim, category, preview });
    if (totals[category] != null) totals[category] += 1;
  }

  JSON_FIELD_RE.lastIndex = 0;
  let m;
  while ((m = JSON_FIELD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const name = m[1];
    const cat = classifyClaim(name);
    push(name, cat, previewValue(m[2]));
  }

  if (entries.length < MAX_PER_FILE) {
    PAYLOAD_ACCESS_RE.lastIndex = 0;
    while ((m = PAYLOAD_ACCESS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const name = m[1].toLowerCase();
      const cat = classifyClaim(name);
      push(name, cat, '');
    }
  }

  let tokenCount = 0;
  JWT_HEADER_RE.lastIndex = 0;
  while (JWT_HEADER_RE.exec(body) && tokenCount < 20) tokenCount += 1;
  totals.tokens = tokenCount;
  if (tokenCount && entries.length < MAX_PER_FILE) {
    entries.push({ claim: '<bearer>', category: 'token', preview: `${tokenCount} JWT(s) detected` });
  }

  return { entries, totals, total: entries.length };
}

function buildJwtClaimsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { registered: 0, oidc: 0, common: 0, custom: 0, tokens: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractJwtClaims(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.category}:${e.claim}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.category] != null) totals[e.category] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderJwtClaimsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## JWT CLAIMS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 12)) {
      const prev = e.preview ? ` = \`${e.preview}\`` : '';
      lines.push(`- [${e.category}] \`${e.claim}\`${prev}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractJwtClaims,
  buildJwtClaimsForFiles,
  renderJwtClaimsBlock,
  _internal: { classifyClaim, previewValue, REGISTERED, OIDC, COMMON },
};
