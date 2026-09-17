'use strict';

/**
 * Coolify / Dokploy-style HTTP request builder + injectable client.
 *
 * Never calls global fetch by default. A later PR may inject a client.
 * Tokens come from env names only — never hardcoded, never returned.
 */

const { fail } = require('../coding-sandbox/errors');
const { assertAllowlisted, normalizeOrigin } = require('./allowlist');

const PROVIDERS = Object.freeze(['stub', 'coolify', 'dokploy']);
const TOKEN_ENV_NAMES = Object.freeze([
  'AGENTES_CODING_DEPLOY_TOKEN',
  'COOLIFY_TOKEN',
  'DOKPLOY_TOKEN',
]);

function normalizeProvider(value) {
  const p = String(value || 'stub').trim().toLowerCase();
  if (!PROVIDERS.includes(p)) fail('E_PARAMS', 'Proveedor de despliegue no soportado (stub, coolify, dokploy).');
  return p;
}

function readToken(env = process.env, opts = {}) {
  if (opts.token != null && opts.token !== '') return String(opts.token);
  for (const name of TOKEN_ENV_NAMES) {
    const v = env[name];
    if (v != null && String(v).trim()) return String(v);
  }
  return '';
}

function joinUrl(origin, path) {
  const base = String(origin || '').replace(/\/+$/, '');
  const rel = String(path || '').startsWith('/') ? path : `/${path || ''}`;
  return `${base}${rel}`;
}

function buildDeployRequest({ provider, baseUrl, appId, name, token }) {
  const kind = normalizeProvider(provider);
  const origin = normalizeOrigin(baseUrl);
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (kind === 'coolify') {
    if (token) headers.Authorization = `Bearer ${token}`;
    return {
      provider: kind,
      method: 'POST',
      url: joinUrl(origin, '/api/v1/deploy'),
      headers,
      body: {
        uuid: String(appId || '').trim() || undefined,
        force: false,
        name: name ? String(name).slice(0, 80) : undefined,
      },
    };
  }
  if (kind === 'dokploy') {
    if (token) headers['x-api-key'] = token;
    return {
      provider: kind,
      method: 'POST',
      url: joinUrl(origin, '/api/application.deploy'),
      headers,
      body: {
        applicationId: String(appId || '').trim() || undefined,
        name: name ? String(name).slice(0, 80) : undefined,
      },
    };
  }
  return {
    provider: 'stub',
    method: 'POST',
    url: joinUrl(origin, '/api/stub/deploy'),
    headers,
    body: { name: name ? String(name).slice(0, 80) : undefined },
  };
}

function redactRequest(request) {
  const headers = { ...(request.headers || {}) };
  if (headers.Authorization) headers.Authorization = 'Bearer [redacted]';
  if (headers.authorization) headers.authorization = 'Bearer [redacted]';
  if (headers['x-api-key']) headers['x-api-key'] = '[redacted]';
  if (headers['X-Api-Key']) headers['X-Api-Key'] = '[redacted]';
  return {
    provider: request.provider,
    method: request.method,
    url: request.url,
    headers,
    body: request.body,
  };
}

function defaultHttpClient() {
  fail('E_DEPLOY_DENIED', 'No hay cliente HTTP inyectable; Coolify/Dokploy no se llama.');
}

async function invokeHttp(httpClient, request, opts = {}) {
  const client = typeof httpClient === 'function' ? httpClient : defaultHttpClient;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8_000;
  const started = Date.now();
  try {
    const out = await Promise.race([
      client({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
        provider: request.provider,
      }),
      new Promise((_, reject) => {
        setTimeout(() => {
          const err = new Error('timeout');
          err.code = 'E_TIMEOUT';
          reject(err);
        }, timeoutMs);
      }),
    ]);
    return {
      ok: out && out.ok !== false && (out.status == null || (out.status >= 200 && out.status < 300)),
      status: out && out.status != null ? Number(out.status) : 200,
      body: out && out.body != null ? out.body : out,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    if (err && err.code === 'E_TIMEOUT') fail('E_TIMEOUT', 'El proveedor de despliegue no respondió a tiempo.');
    if (err && err.code && err.status) throw err;
    fail('E_DEPLOY_FAILED', String(err && err.message || err || '').slice(0, 160));
    return null;
  }
}

function prepareLiveCall({ provider, baseUrl, appId, name, env, extraAllowlist, token }) {
  const origin = assertAllowlisted(baseUrl, env, extraAllowlist);
  const secret = readToken(env, { token });
  return buildDeployRequest({
    provider,
    baseUrl: origin,
    appId,
    name,
    token: secret,
  });
}

module.exports = {
  PROVIDERS,
  TOKEN_ENV_NAMES,
  normalizeProvider,
  readToken,
  buildDeployRequest,
  redactRequest,
  defaultHttpClient,
  invokeHttp,
  prepareLiveCall,
};
