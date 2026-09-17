'use strict';

/**
 * Port parse / allowlist / localhost mapping metadata.
 * Never binds a real socket unless a caller injects mapPort.
 */

const { fail } = require('../coding-sandbox/errors');

const MAX_EXPOSED_PORTS = 8;

function parsePort(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    fail('E_PARAMS', 'Puerto inválido.');
  }
  return n;
}

function parsePortAllowlist(value) {
  if (value == null) return [];
  const raw = Array.isArray(value)
    ? value
    : String(value).split(/[\s,]+/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (item == null || item === '') continue;
    const n = Number.parseInt(item, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function parseEnvPortAllowlist(env = process.env) {
  return parsePortAllowlist(env.AGENTES_CODING_PREVIEW_PORTS);
}

function defaultMapPort({ port, session }) {
  const n = parsePort(port);
  const driver = session && session.driver === 'docker' ? 'docker' : 'memory';
  return {
    host: '127.0.0.1',
    hostPort: n,
    published: true,
    bind: false,
    driver,
  };
}

function publicExposed(record) {
  if (!record) return null;
  return {
    port: record.port,
    published: record.published === true,
    url: record.url || null,
    host: record.host || null,
    hostPort: record.hostPort || null,
    expiresAt: record.expiresAt || null,
    driver: record.driver || null,
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPreviewStub(preview) {
  const port = escapeHtml(preview && preview.port);
  const host = escapeHtml((preview && preview.host) || '127.0.0.1');
  const hostPort = escapeHtml((preview && preview.hostPort) || port);
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Vista previa</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
</head>
<body>
<p>Vista previa efímera del sandbox (DEV).</p>
<p>Puerto ${port} → ${host}:${hostPort}.</p>
</body>
</html>
`;
}

module.exports = {
  MAX_EXPOSED_PORTS,
  parsePort,
  parsePortAllowlist,
  parseEnvPortAllowlist,
  defaultMapPort,
  publicExposed,
  renderPreviewStub,
  escapeHtml,
};
