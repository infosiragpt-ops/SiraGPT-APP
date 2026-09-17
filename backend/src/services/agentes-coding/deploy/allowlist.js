'use strict';

/**
 * Deploy base-URL allowlist. Deny-by-default. Never embed secrets.
 */

const { fail } = require('../coding-sandbox/errors');

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

function parseAllowlist(env = process.env, extra = []) {
  const raw = [
    env.AGENTES_CODING_DEPLOY_BASE_URLS,
    env.AGENTES_CODING_DEPLOY_BASE_URL,
    ...(Array.isArray(extra) ? extra : [extra]),
  ]
    .flatMap((value) => String(value || '').split(/[\s,]+/))
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const origin = normalizeOrigin(item, { soft: true });
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

function normalizeOrigin(value, { soft = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (soft) return null;
    fail('E_PARAMS', 'Falta la URL base de despliegue.');
  }
  if (/[\x00-\x1f]/.test(raw) || raw.includes('\\') || raw.includes('@')) {
    if (soft) return null;
    fail('E_DEPLOY_DENIED', 'La URL de despliegue no es válida.');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    if (soft) return null;
    fail('E_DEPLOY_DENIED', 'La URL de despliegue no es válida.');
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    if (soft) return null;
    fail('E_DEPLOY_DENIED', 'Solo se permiten http/https en la URL de despliegue.');
  }
  if (url.username || url.password) {
    if (soft) return null;
    fail('E_DEPLOY_DENIED', 'La URL no puede incluir credenciales.');
  }
  if (!url.hostname) {
    if (soft) return null;
    fail('E_DEPLOY_DENIED', 'La URL de despliegue no tiene host.');
  }
  return `${url.protocol}//${url.host}`.toLowerCase();
}

function isAllowlisted(baseUrl, env = process.env, extra = []) {
  const origin = normalizeOrigin(baseUrl);
  return parseAllowlist(env, extra).includes(origin);
}

function assertAllowlisted(baseUrl, env = process.env, extra = []) {
  const origin = normalizeOrigin(baseUrl);
  const list = parseAllowlist(env, extra);
  if (!list.length) {
    fail('E_DEPLOY_DENIED', 'Configura AGENTES_CODING_DEPLOY_BASE_URLS.');
  }
  if (!list.includes(origin)) {
    fail('E_DEPLOY_DENIED', 'La URL base no está en la allowlist.');
  }
  return origin;
}

module.exports = {
  parseAllowlist,
  normalizeOrigin,
  isAllowlisted,
  assertAllowlisted,
};
