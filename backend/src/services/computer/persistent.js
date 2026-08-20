'use strict';

/**
 * Persistent per-member Linux desktop client.
 *
 * One SiraGPT user → one orchestrator session (container sira-ac-user-*).
 * Department agents share that desktop. Do not create per-department VMs.
 *
 * Prefer this executor over any webtop (sira-dpc-* PNG CEO Office) when
 * both are offered. Webtop is never auto-loaded here.
 */

const { orchFetch, resolveOrchConfig } = require('./orch-client');
const { agentComputerEnabled, resolveObservationMode } = require('./flags');

class UserIdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserIdError';
    this.status = 400;
    this.code = 'invalid_user_id';
  }
}

function normalizeUserId(userId) {
  const id = String(userId == null ? '' : userId).trim();
  if (!id) throw new UserIdError('userId is required');
  if (id.length > 128) throw new UserIdError('userId is too long');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new UserIdError('userId contains unsupported characters');
  }
  return id;
}

/** Stable key for the member's one desktop. Department is not part of it. */
function memberKey(userId) {
  return `member:${normalizeUserId(userId)}`;
}

function isConfigured(env = process.env) {
  return resolveOrchConfig(env).enabled;
}

function computerToolsAvailable({ userId, env = process.env } = {}) {
  if (!userId) return false;
  return agentComputerEnabled(env) || isConfigured(env);
}

function resolveComputerOnlyTurn({
  disableAgentic,
  publicWebReadonly,
  userId,
  toolCallMode,
  env = process.env,
} = {}) {
  return disableAgentic === true
    && !publicWebReadonly
    && Boolean(userId)
    && toolCallMode !== 'none'
    && computerToolsAvailable({ userId, env });
}

/**
 * Pick the desktop backend. Persistent member session always wins over
 * a webtop (dept-real-pc / sira-dpc-*-ceo-office) when both exist.
 *
 * `webtop` is injectable for tests; production never constructs one here.
 */
function selectComputerExecutor({
  userId,
  env = process.env,
  persistent,
  webtop,
} = {}) {
  const persistentClient = persistent || {
    isAvailable: ({ userId: uid, env: e } = {}) => (
      Boolean(uid) && isConfigured(e || env)
    ),
  };
  const persistentReady = typeof persistentClient.isAvailable === 'function'
    ? persistentClient.isAvailable({ userId, env })
    : Boolean(persistentClient && userId && isConfigured(env));

  if (persistentReady) {
    return {
      kind: 'persistent',
      reason: 'member_session',
      memberKey: userId ? memberKey(userId) : null,
      client: persistentClient,
    };
  }

  const webtopReady = webtop
    ? (typeof webtop.isAvailable === 'function' ? webtop.isAvailable({ userId, env }) : Boolean(webtop))
    : false;
  if (webtopReady) {
    return {
      kind: 'webtop',
      reason: 'fallback_only',
      memberKey: userId ? memberKey(userId) : null,
      client: webtop,
    };
  }

  return { kind: 'none', reason: 'unavailable', memberKey: null, client: null };
}

async function ensureSession(userId, { env = process.env, fetchImpl } = {}) {
  const id = normalizeUserId(userId);
  return orchFetch('/sessions', {
    method: 'POST',
    body: { userId: id },
    env,
    fetchImpl,
  });
}

function agentFetch(session, path, { method = 'GET', body, fetchImpl, headers } = {}) {
  const fetchFn = fetchImpl || fetch;
  const base = String(session && session.agentUrl || '').replace(/\/$/, '');
  if (!base) {
    const err = new Error('persistent desktop has no agentUrl');
    err.code = 'NO_AGENT_URL';
    throw err;
  }
  return fetchFn(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(headers || {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

/**
 * Observe the member desktop. Models without vision get the Chrome CDP
 * accessibility tree (text). Pixel PNGs are only used when the model is
 * listed in COMPUTER_VISION_MODELS. Never send screenshots-to-model by default.
 */
async function observe(userId, opts = {}) {
  const session = opts.session || await ensureSession(userId, opts);
  const mode = resolveObservationMode({
    cdpMode: opts.cdpMode,
    model: opts.model,
    env: opts.env,
  });
  if (mode === 'cdp') {
    const snap = opts.cdpSnapshot || require('./cdp-client').snapshotAccessibility;
    const tree = await snap(session.cdpUrl, {
      playwrightImpl: opts.playwrightImpl,
      connect: opts.cdpConnect,
    });
    return {
      mode: 'cdp',
      backend: 'persistent',
      session,
      url: tree.url || null,
      title: tree.title || '',
      text: tree.text || '(empty)',
    };
  }
  const shot = await screenshot(userId, { ...opts, session });
  return {
    mode: 'screenshot',
    backend: 'persistent',
    session,
    png: shot.png,
    mediaType: shot.mediaType || 'image/png',
    text: shot.text || '',
  };
}

async function screenshot(userId, opts = {}) {
  const session = opts.session || await ensureSession(userId, opts);
  const res = await agentFetch(session, '/screenshot', { fetchImpl: opts.fetchImpl });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `screenshot HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { session, ...data, backend: 'persistent' };
}

async function click(userId, { x, y, button = 'left' } = {}, opts = {}) {
  const session = opts.session || await ensureSession(userId, opts);
  const res = await agentFetch(session, '/action', {
    method: 'POST',
    body: { type: 'click', x, y, button },
    fetchImpl: opts.fetchImpl,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `click HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { session, ...data, backend: 'persistent' };
}

async function typeText(userId, { text } = {}, opts = {}) {
  const session = opts.session || await ensureSession(userId, opts);
  const res = await agentFetch(session, '/action', {
    method: 'POST',
    body: { type: 'type', text },
    fetchImpl: opts.fetchImpl,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `type HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { session, ...data, backend: 'persistent' };
}

function parsePublicPageUrl(rawUrl) {
  const { parseSafeOutboundUrl } = require('../../utils/url-ssrf-guard');
  return parseSafeOutboundUrl(rawUrl, { allowHttp: true });
}

/**
 * Open a public page in Chrome on the member desktop via Chrome's
 * DevTools HTTP API (`PUT /json/new?<url>`). No Playwright, no OpenRouter.
 */
async function navigate(userId, { url } = {}, opts = {}) {
  const parsed = parsePublicPageUrl(url);
  const session = opts.session || await ensureSession(userId, opts);
  const navigatePage = opts.navigatePage;
  if (typeof navigatePage === 'function') {
    const result = await navigatePage({ session, url: parsed.toString() });
    return { session, url: parsed.toString(), backend: 'persistent', ...result };
  }
  const cdpBase = String(session.cdpUrl || '').replace(/\/$/, '');
  if (!cdpBase) {
    const err = new Error('persistent desktop has no cdpUrl');
    err.code = 'NO_CDP_URL';
    throw err;
  }
  const fetchFn = opts.fetchImpl || fetch;
  const res = await fetchFn(`${cdpBase}/json/new?${encodeURIComponent(parsed.toString())}`, {
    method: 'PUT',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `navigate HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { session, url: parsed.toString(), backend: 'persistent', tab: data };
}

module.exports = {
  UserIdError,
  normalizeUserId,
  memberKey,
  isConfigured,
  computerToolsAvailable,
  resolveComputerOnlyTurn,
  selectComputerExecutor,
  ensureSession,
  observe,
  screenshot,
  click,
  typeText,
  navigate,
  parsePublicPageUrl,
};
