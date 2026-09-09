'use strict';

/**
 * agentes-coding/preview — signed ephemeral preview URL (Phase 3e).
 *
 * OpenSandbox / E2B getHost pattern, rewritten natively. Memory + docker
 * drivers return a signed URL stub and localhost-mapped port metadata.
 * Networking is injectable (no real bind in CI). Flag: AGENTES_CODING_V2.
 *
 * See docs/agentes-coding-preview.md
 */

const crypto = require('node:crypto');
const { isAgentesCodingV2Enabled } = require('../flags');
const { fail, CodingSandboxError } = require('../coding-sandbox/errors');
const {
  DEFAULT_TTL_MS,
  clampTtlMs,
  resolvePreviewSecret,
  signPreviewToken,
  verifyPreviewToken,
  mintPreviewClaims,
} = require('./token');
const {
  MAX_EXPOSED_PORTS,
  parsePort,
  parsePortAllowlist,
  parseEnvPortAllowlist,
  defaultMapPort,
  publicExposed,
  renderPreviewStub,
} = require('./ports');

function requireEnabled(env = process.env) {
  if (!isAgentesCodingV2Enabled(env)) fail('E_FLAG_OFF');
}

function createPreviewBinder(opts = {}) {
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const ttlMs = clampTtlMs(opts.ttlMs || env.AGENTES_CODING_PREVIEW_TTL_MS, DEFAULT_TTL_MS);
  const publicBase = String(opts.publicBase || '/api/agentes-coding/sessions').replace(/\/+$/, '');
  const generatedSecret = opts.generatedSecret
    || crypto.randomBytes(24).toString('hex');
  const mapPort = typeof opts.mapPort === 'function' ? opts.mapPort : defaultMapPort;

  function secret() {
    return resolvePreviewSecret({ ...opts, generatedSecret }, env);
  }

  async function bind(session, port) {
    const n = parsePort(port);
    let mapping;
    try {
      mapping = await mapPort({ session, port: n, driver: session.driver, now });
    } catch (err) {
      if (err instanceof CodingSandboxError) throw err;
      fail('E_PREVIEW_FAILED', String(err && err.message || err || '').slice(0, 160));
    }
    if (!mapping || mapping.published === false) {
      fail('E_PREVIEW_FAILED', 'El mapeo de puerto no publicó el servicio.');
    }
    const claims = mintPreviewClaims({
      sessionId: session.id,
      port: n,
      ttlMs,
      now,
    });
    const token = signPreviewToken(claims, secret());
    const url = `${publicBase}/${encodeURIComponent(session.id)}/preview/${encodeURIComponent(token)}`;
    return {
      port: n,
      published: true,
      url,
      token,
      host: mapping.host || '127.0.0.1',
      hostPort: Number(mapping.hostPort) || n,
      expiresAt: claims.exp,
      driver: session.driver,
      bind: mapping.bind === true,
    };
  }

  function verify(token, expectedSessionId) {
    const claims = verifyPreviewToken(token, secret(), now);
    if (!claims) fail('E_PARAMS', 'Token de vista previa inválido.');
    if (expectedSessionId && claims.sid !== expectedSessionId) {
      fail('E_SESSION_NOT_FOUND', 'El token no pertenece a esta sesión.');
    }
    if (now() >= claims.exp) fail('E_PREVIEW_EXPIRED');
    return claims;
  }

  return Object.freeze({
    bind,
    verify,
    secret,
    ttlMs,
    publicBase,
    now,
  });
}

function exposeForRequest(sandbox, sessionId, body, env) {
  requireEnabled(env);
  return sandbox.exposePort(sessionId, body && (body.port ?? body.hostPort));
}

function listForRequest(sandbox, sessionId, env) {
  requireEnabled(env);
  return sandbox.listPorts(sessionId);
}

function unexposeForRequest(sandbox, sessionId, port, env) {
  requireEnabled(env);
  return sandbox.unexposePort(sessionId, port);
}

function resolveForRequest(sandbox, sessionId, token, env) {
  requireEnabled(env);
  return sandbox.resolvePreview(sessionId, token);
}

module.exports = {
  createPreviewBinder,
  exposeForRequest,
  listForRequest,
  unexposeForRequest,
  resolveForRequest,
  requireEnabled,
  parsePort,
  parsePortAllowlist,
  parseEnvPortAllowlist,
  defaultMapPort,
  publicExposed,
  renderPreviewStub,
  signPreviewToken,
  verifyPreviewToken,
  clampTtlMs,
  DEFAULT_TTL_MS,
  MAX_EXPOSED_PORTS,
  CodingSandboxError,
};
