'use strict';

/**
 * document-oauth-flows.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects OAuth 2.0 / OIDC flow parameters and endpoint references:
 *
 *   - grant_type:      authorization_code / client_credentials / password /
 *                      refresh_token / urn:ietf:params:oauth:grant-type:device_code
 *   - response_type:   code / token / id_token / code id_token
 *   - response_mode:   query / fragment / form_post
 *   - PKCE:            code_challenge / code_challenge_method (S256/plain) / code_verifier
 *   - Parameters:      redirect_uri / client_id (masked) / state / nonce / scope
 *   - Endpoints:       /authorize / /token / /revoke / /introspect / /userinfo /
 *                      /.well-known/openid-configuration
 *   - Token types:     Bearer / DPoP / MAC
 *   - Errors:          invalid_request / invalid_grant / access_denied / unauthorized_client
 *
 *   client_id values are MASKED — only the parameter name (and short suffix) is emitted.
 *
 * Public API:
 *   extractOauthFlows(text)             → { entries, totals, total }
 *   buildOauthFlowsForFiles(files)      → { perFile, aggregate, totals }
 *   renderOauthFlowsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const GRANT_TYPE_RE = /\bgrant_type["']?\s*[=:,]\s*["']?(authorization_code|client_credentials|password|refresh_token|implicit|urn:ietf:params:oauth:grant-type:(?:device_code|jwt-bearer|saml2-bearer|token-exchange))["']?/g;
const RESPONSE_TYPE_RE = /\bresponse_type["']?\s*[=:,]\s*["']?(code(?:\s+id_token)?(?:\s+token)?|token|id_token|none)["']?/g;
const RESPONSE_MODE_RE = /\bresponse_mode["']?\s*[=:,]\s*["']?(query|fragment|form_post|web_message)["']?/g;
const PKCE_CHALLENGE_RE = /\bcode_challenge_method["']?\s*[=:,]\s*["']?(S256|plain)["']?/g;
const PKCE_REFS_RE = /\b(code_challenge|code_verifier|code_challenge_method)\b/g;
const REDIRECT_URI_RE = /\bredirect_uri["']?\s*[=:,]\s*["']([^"'\n\s]{1,200})["']?/g;
const CLIENT_ID_RE = /\bclient_id["']?\s*[=:,]\s*["']?([a-zA-Z0-9._-]{4,80})["']?/g;
const STATE_RE = /\b(state|nonce)["']?\s*[=:,]\s*["']?([a-zA-Z0-9._-]{4,80})["']?/g;
const SCOPE_RE = /\bscope["']?\s*[=:,]\s*["']?([a-zA-Z][a-zA-Z0-9\s:.-]{2,200})["']?/g;
const ENDPOINT_RE = /(?:\/oauth2?|\/auth|\/openid)?(?:\/authorize|\/token|\/revoke|\/introspect|\/userinfo|\/jwks(?:\.json)?|\/\.well-known\/openid-configuration|\/\.well-known\/oauth-authorization-server)/g;
const TOKEN_TYPE_RE = /\btoken_type\s*[=:]\s*["']?(Bearer|DPoP|MAC|N_A)["']?|\bauthorization\s*:\s*["']?(Bearer|DPoP)\s+/gi;
const OAUTH_ERROR_RE = /\b(invalid_request|invalid_client|invalid_grant|invalid_scope|invalid_token|unauthorized_client|unsupported_grant_type|unsupported_response_type|access_denied|server_error|temporarily_unavailable|interaction_required|login_required|consent_required|account_selection_required)\b/g;

function maskClientId(id) {
  if (id.length <= 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function isOauthLike(body) {
  return /\bgrant_type\s*[=:]|\bresponse_type\s*[=:]\s*["']?(?:code|token|id_token)|\bredirect_uri\s*[=:]|\bcode_challenge_method\b|\b\/\.well-known\/(?:openid-configuration|oauth-authorization-server)\b|authorization_code|client_credentials/.test(body);
}

function extractOauthFlows(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isOauthLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    grantType: 0, responseType: 0, responseMode: 0, pkce: 0,
    redirectUri: 0, clientId: 0, state: 0, nonce: 0, scope: 0,
    endpoint: 0, tokenType: 0, error: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  GRANT_TYPE_RE.lastIndex = 0;
  let m;
  while ((m = GRANT_TYPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('grantType', m[1], null);
  }
  if (entries.length < MAX_PER_FILE) {
    RESPONSE_TYPE_RE.lastIndex = 0;
    while ((m = RESPONSE_TYPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('responseType', m[1].trim(), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RESPONSE_MODE_RE.lastIndex = 0;
    while ((m = RESPONSE_MODE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('responseMode', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PKCE_CHALLENGE_RE.lastIndex = 0;
    while ((m = PKCE_CHALLENGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('pkce', `code_challenge_method=${m[1]}`, null);
    }
  }
  let pkceRefCount = 0;
  PKCE_REFS_RE.lastIndex = 0;
  while (PKCE_REFS_RE.exec(body) && pkceRefCount < 20) pkceRefCount += 1;
  // Count adds to totals.pkce alongside method entries
  totals.pkce = (totals.pkce || 0) + pkceRefCount;

  if (entries.length < MAX_PER_FILE) {
    REDIRECT_URI_RE.lastIndex = 0;
    while ((m = REDIRECT_URI_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('redirectUri', m[1].slice(0, 80), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CLIENT_ID_RE.lastIndex = 0;
    while ((m = CLIENT_ID_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('clientId', 'client_id', maskClientId(m[1]));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    STATE_RE.lastIndex = 0;
    while ((m = STATE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const kind = m[1];
      const masked = m[2].length > 8 ? `${m[2].slice(0, 4)}…` : m[2];
      push(kind === 'state' ? 'state' : 'nonce', kind, masked);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SCOPE_RE.lastIndex = 0;
    while ((m = SCOPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const scopes = m[1].trim().slice(0, 80);
      push('scope', 'scope', scopes);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ENDPOINT_RE.lastIndex = 0;
    while ((m = ENDPOINT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('endpoint', m[0], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    TOKEN_TYPE_RE.lastIndex = 0;
    while ((m = TOKEN_TYPE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('tokenType', m[1] || m[2], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    OAUTH_ERROR_RE.lastIndex = 0;
    while ((m = OAUTH_ERROR_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('error', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildOauthFlowsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    grantType: 0, responseType: 0, responseMode: 0, pkce: 0,
    redirectUri: 0, clientId: 0, state: 0, nonce: 0, scope: 0,
    endpoint: 0, tokenType: 0, error: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractOauthFlows(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}:${e.detail || ''}`;
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

function renderOauthFlowsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## OAUTH 2.0 FLOWS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` = \`${e.detail}\`` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractOauthFlows,
  buildOauthFlowsForFiles,
  renderOauthFlowsBlock,
  _internal: { maskClientId, isOauthLike },
};
