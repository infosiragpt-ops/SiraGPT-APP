'use strict';

/**
 * agentes-coding/deploy — stub that records deploy intent.
 *
 * Coolify/Dokploy are external HTTP APIs only (injectable client).
 * Never hardcode secrets. Deny unless allowlisted base URL.
 * Flag: AGENTES_CODING_V2 (default OFF).
 *
 * See docs/agentes-coding-export-deploy.md
 */

const crypto = require('node:crypto');
const { isAgentesCodingV2Enabled } = require('../flags');
const { fail } = require('../coding-sandbox/errors');
const { normalizeProvider, redactRequest, invokeHttp, prepareLiveCall } = require('./client');
const { parseAllowlist } = require('./allowlist');

const MAX_DEPLOYS = 16;
const MAX_NAME = 80;

const STATUS_COPY = Object.freeze({
  registrado: 'Intención de despliegue registrada. No se llamó a un proveedor externo.',
  enviado: 'Solicitud enviada al adaptador de despliegue.',
  denegado: 'Despliegue denegado: falta allowlist de URL o cliente inyectable.',
  error: 'El proveedor de despliegue no aceptó la solicitud.',
});

function requireEnabled(env = process.env) {
  if (!isAgentesCodingV2Enabled(env)) fail('E_FLAG_OFF');
}

async function requireSession(sandbox, sessionId) {
  if (!sandbox || typeof sandbox.listFiles !== 'function') {
    fail('E_PARAMS', 'Falta el sandbox de la sesión.');
  }
  await sandbox.listFiles(sessionId, '.');
  const raw = typeof sandbox._unsafeGetRaw === 'function'
    ? sandbox._unsafeGetRaw(sessionId)
    : null;
  if (!raw) fail('E_SESSION_NOT_FOUND');
  return raw;
}

function getStore(raw) {
  if (!raw.deploys) raw.deploys = { items: [] };
  if (!Array.isArray(raw.deploys.items)) raw.deploys.items = [];
  return raw.deploys;
}

function sanitizeName(value) {
  const name = String(value == null ? '' : value).trim();
  if (!name) return 'proyecto';
  if (name.length > MAX_NAME) fail('E_PARAMS', `El nombre supera ${MAX_NAME} caracteres.`);
  if (/[\x00-\x1f]/.test(name)) fail('E_PARAMS', 'El nombre contiene caracteres de control.');
  return name;
}

function wantsLive(opts = {}) {
  if (opts.live === true || opts.live === '1' || opts.live === 'true') return true;
  const provider = String(opts.provider || 'stub').trim().toLowerCase();
  return (provider === 'coolify' || provider === 'dokploy') && Boolean(opts.baseUrl);
}

function publicDeploy(row) {
  return {
    id: row.id,
    status: row.status,
    message: row.message,
    provider: row.provider,
    name: row.name,
    recordedAt: row.recordedAt,
    live: row.live === true,
    request: row.request || null,
    remoteStatus: row.remoteStatus == null ? null : row.remoteStatus,
  };
}

async function recordIntent(sandbox, sessionId, opts = {}) {
  const raw = await requireSession(sandbox, sessionId);
  const provider = normalizeProvider(opts.provider || 'stub');
  const name = sanitizeName(opts.name || opts.app || opts.project);
  const id = `dep_${crypto.randomBytes(8).toString('hex')}`;
  const row = {
    id,
    status: 'registrado',
    message: STATUS_COPY.registrado,
    provider,
    name,
    recordedAt: Date.now(),
    live: false,
    request: null,
    remoteStatus: null,
    sessionId,
  };

  if (wantsLive(opts)) {
    const env = opts.env || process.env;
    const httpClient = typeof opts.httpClient === 'function'
      ? opts.httpClient
      : (typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null);
    if (typeof httpClient !== 'function') {
      fail('E_DEPLOY_DENIED', 'Coolify/Dokploy exige un cliente HTTP inyectable.');
    }
    if (!opts.baseUrl) fail('E_PARAMS', 'Falta la URL base de despliegue.');
    const request = prepareLiveCall({
      provider,
      baseUrl: opts.baseUrl,
      appId: opts.appId || opts.uuid || opts.applicationId,
      name,
      env,
      extraAllowlist: opts.allowlist,
      token: opts.token,
    });
    row.live = true;
    row.request = redactRequest(request);
    const remote = await invokeHttp(httpClient, request, { timeoutMs: opts.timeoutMs });
    row.remoteStatus = remote.status;
    if (!remote.ok) {
      row.status = 'error';
      row.message = STATUS_COPY.error;
      const storeFailed = getStore(raw);
      storeFailed.items.push(row);
      if (storeFailed.items.length > MAX_DEPLOYS) {
        storeFailed.items.splice(0, storeFailed.items.length - MAX_DEPLOYS);
      }
      fail('E_DEPLOY_FAILED', `HTTP ${remote.status || ''}`.trim());
    }
    row.status = 'enviado';
    row.message = STATUS_COPY.enviado;
  }

  const store = getStore(raw);
  store.items.push(row);
  if (store.items.length > MAX_DEPLOYS) store.items.splice(0, store.items.length - MAX_DEPLOYS);
  return { ok: true, deploy: publicDeploy(row) };
}

async function listDeploys(sandbox, sessionId) {
  const raw = await requireSession(sandbox, sessionId);
  return { ok: true, deploys: getStore(raw).items.map(publicDeploy) };
}

async function getDeploy(sandbox, sessionId, deployId) {
  const raw = await requireSession(sandbox, sessionId);
  const id = String(deployId || '').trim();
  if (!id) fail('E_PARAMS', 'Falta el id de despliegue.');
  const row = getStore(raw).items.find((item) => item.id === id);
  if (!row) fail('E_DEPLOY_NOT_FOUND');
  return { ok: true, deploy: publicDeploy(row) };
}

function forget(sandbox, sessionId) {
  const raw = sandbox && typeof sandbox._unsafeGetRaw === 'function'
    ? sandbox._unsafeGetRaw(sessionId)
    : null;
  if (raw && raw.deploys) raw.deploys = { items: [] };
}

async function deployForRequest(sandbox, sessionId, opts, env, extras = {}) {
  requireEnabled(env);
  return recordIntent(sandbox, sessionId, {
    ...opts,
    env,
    httpClient: extras.httpClient || extras.fetchImpl || (opts && (opts.httpClient || opts.fetchImpl)),
  });
}

async function listForRequest(sandbox, sessionId, env) {
  requireEnabled(env);
  return listDeploys(sandbox, sessionId);
}

async function getForRequest(sandbox, sessionId, deployId, env) {
  requireEnabled(env);
  return getDeploy(sandbox, sessionId, deployId);
}

module.exports = {
  STATUS_COPY,
  requireEnabled,
  recordIntent,
  listDeploys,
  getDeploy,
  forget,
  deployForRequest,
  listForRequest,
  getForRequest,
  parseAllowlist,
};
