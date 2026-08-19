'use strict';

/**
 * document-nginx.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Nginx configuration directives:
 *
 *   - server { ... } / location PATH { ... } / upstream NAME { ... }
 *   - listen 80 / listen 443 ssl http2 / listen [::]:80
 *   - server_name example.com www.example.com
 *   - proxy_pass http://backend / proxy_set_header / proxy_buffering
 *   - ssl_certificate / ssl_certificate_key / ssl_protocols / ssl_ciphers
 *   - root / index / try_files / rewrite / return / error_page
 *   - access_log / error_log / log_format
 *   - gzip / brotli / cache directives
 *   - limit_req / limit_conn rate limiting
 *
 * Public API:
 *   extractNginx(text)             → { entries, totals, total }
 *   buildNginxForFiles(files)      → { perFile, aggregate, totals }
 *   renderNginxBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 30;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const SERVER_BLOCK_RE = /^\s*server\s*\{/gm;
const LOCATION_RE = /^\s*location\s+(?:[=~^*]+\s+)?([^\s{]{1,200})\s*\{/gm;
const UPSTREAM_RE = /^\s*upstream\s+([a-zA-Z_][a-zA-Z0-9_-]{0,60})\s*\{/gm;
const LISTEN_RE = /^\s*listen\s+([^;\n]{1,80});/gm;
const SERVER_NAME_RE = /^\s*server_name\s+([^;\n]{1,200});/gm;
const PROXY_PASS_RE = /^\s*proxy_pass\s+([^;\n]{1,200});/gm;
const SSL_CERT_RE = /^\s*(ssl_certificate|ssl_certificate_key|ssl_trusted_certificate)\s+([^;\n]{1,200});/gm;
const SSL_OPTS_RE = /^\s*(ssl_protocols|ssl_ciphers|ssl_prefer_server_ciphers|ssl_session_cache|ssl_session_timeout|ssl_dhparam|ssl_stapling)\s+([^;\n]{1,200});/gm;
const ROUTING_RE = /^\s*(root|index|try_files|rewrite|return|error_page|alias)\s+([^;\n]{1,200});/gm;
const HEADER_RE = /^\s*(add_header|proxy_set_header|expires)\s+([^;\n]{1,200});/gm;
const COMPRESSION_RE = /^\s*(gzip|gzip_types|gzip_comp_level|gzip_min_length|brotli|brotli_types)\s+([^;\n]{1,200});/gm;
const RATE_LIMIT_RE = /^\s*(limit_req|limit_conn|limit_req_zone|limit_conn_zone|limit_rate)\s+([^;\n]{1,200});/gm;
const LOG_RE = /^\s*(access_log|error_log|log_format)\s+([^;\n]{1,200});/gm;

function isNginxLike(body) {
  return /\b(?:server\s*\{|location\s+[^\s{]|upstream\s+\w+\s*\{|proxy_pass\s|listen\s+\d+\s*[;\s]|server_name\s+)/.test(body);
}

function extractNginx(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isNginxLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    serverBlock: 0, location: 0, upstream: 0, listen: 0,
    serverName: 0, proxyPass: 0, sslCert: 0, sslOpt: 0,
    routing: 0, header: 0, compression: 0, rateLimit: 0, log: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  let serverCount = 0;
  SERVER_BLOCK_RE.lastIndex = 0;
  while (SERVER_BLOCK_RE.exec(body) && serverCount < 10) serverCount += 1;
  totals.serverBlock = serverCount;
  if (serverCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'serverBlock', name: 'server', detail: `${serverCount} block(s)` });
  }

  let m;
  LOCATION_RE.lastIndex = 0;
  while ((m = LOCATION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('location', m[1].slice(0, 60), null);
  }
  if (entries.length < MAX_PER_FILE) {
    UPSTREAM_RE.lastIndex = 0;
    while ((m = UPSTREAM_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('upstream', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    LISTEN_RE.lastIndex = 0;
    while ((m = LISTEN_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('listen', m[1].trim().slice(0, 50), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SERVER_NAME_RE.lastIndex = 0;
    while ((m = SERVER_NAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('serverName', m[1].trim().slice(0, 80), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PROXY_PASS_RE.lastIndex = 0;
    while ((m = PROXY_PASS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('proxyPass', m[1].trim().slice(0, 80), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SSL_CERT_RE.lastIndex = 0;
    while ((m = SSL_CERT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('sslCert', m[1], m[2].trim().slice(0, 60));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SSL_OPTS_RE.lastIndex = 0;
    while ((m = SSL_OPTS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('sslOpt', m[1], m[2].trim().slice(0, 60));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    LOG_RE.lastIndex = 0;
    while ((m = LOG_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('log', m[1], m[2].trim().slice(0, 60));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    RATE_LIMIT_RE.lastIndex = 0;
    while ((m = RATE_LIMIT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('rateLimit', m[1], m[2].trim().slice(0, 60));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    COMPRESSION_RE.lastIndex = 0;
    while ((m = COMPRESSION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('compression', m[1], m[2].trim().slice(0, 40));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    ROUTING_RE.lastIndex = 0;
    while ((m = ROUTING_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('routing', m[1], m[2].trim().slice(0, 60));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    HEADER_RE.lastIndex = 0;
    while ((m = HEADER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('header', m[1], m[2].trim().slice(0, 50));
    }
  }

  return { entries, totals, total: entries.length };
}

function buildNginxForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    serverBlock: 0, location: 0, upstream: 0, listen: 0,
    serverName: 0, proxyPass: 0, sslCert: 0, sslOpt: 0,
    routing: 0, header: 0, compression: 0, rateLimit: 0, log: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractNginx(txt);
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

function renderNginxBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## NGINX CONFIGURATION'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` (${e.detail})` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractNginx,
  buildNginxForFiles,
  renderNginxBlock,
  _internal: { isNginxLike },
};
