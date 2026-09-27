'use strict';

/**
 * system-errors — «Errores del sistema» (Admin → Logs): a Sentry-like issue
 * tracker for the siragpt.com backend, built on the AuditLog table.
 *
 * Captures automatically:
 *   - uncaught exceptions / unhandled rejections (index.js process hooks);
 *   - Express errors (global error handler) and any 5xx response, with the
 *     matched route, request id and user;
 *   - console.error lines (BullMQ `[x-worker] worker error`, Redis, Prisma,
 *     sandbox, provider failures…) and the console.warn lines that name a
 *     provider status / Redis / Prisma / queue failure;
 *   - frontend errors posted to /api/telemetry/error.
 *
 * Every event is described (fingerprint.js), noise is dropped (config-absent
 * or feature-disabled answers, expected 4xx, client aborts, our own logs),
 * bursts of the same error (one ReplyError dumping dozens of lines) collapse
 * into ONE event, and a background flush groups events into ISSUES
 * (store.js): new issue / regression → one alert row that the admin-wide
 * listener turns into the «critical» sound + badge. Never throws, never
 * blocks the request that failed.
 *
 * Kill switch: SIRAGPT_SYSTEM_ERRORS=0. Off by default under NODE_ENV=test.
 */

const os = require('os');
const path = require('path');
const fingerprint = require('./fingerprint');
const { createSystemIssueStore, hourKey } = require('./store');

const FLUSH_MS = Math.max(500, Number(process.env.SIRAGPT_SYSTEM_ERRORS_FLUSH_MS) || 5000);
const BURST_WINDOW_MS = 10_000;
const MAX_NEW_ISSUES_PER_MIN = 30;
const MAX_SAMPLES_PER_FLUSH = 3;
const MAX_TRACKED_FINGERPRINTS = 5000;

// console.warn lines worth an issue (warn is otherwise informational).
const WARN_CAPTURE_RE = new RegExp([
  'ReplyError',
  '\\bredis\\b[^\\n]*(?:error|fail|swallowed|rate.?limit|refused|timeout)',
  'prisma',
  '\\bP[12]\\d{3}\\b',
  'worker error',
  'queue error',
  'sandbox[^\\n]*(?:fail|error)',
  '\\b(?:openai|anthropic|deepseek|gemini|xai|grok|meta|cerebras|openrouter|elevenlabs|fal|mistral|groq|minimax|suno|perplexity|typesafe|voicestudio)\\b[^\\n]*\\b(?:4\\d\\d|5\\d\\d)\\b',
  '\\b(?:4\\d\\d|5\\d\\d)\\b[^\\n]*\\b(?:openai|anthropic|deepseek|gemini|xai|grok|meta|cerebras|openrouter|elevenlabs|fal|mistral|groq|minimax|suno|perplexity|typesafe|voicestudio)\\b',
].join('|'), 'i');

// Lines the process hooks already capture with the real error object.
const CONSOLE_SKIP_RE = /^\s*\[FATAL\]\s*(?:uncaughtException|unhandledRejection)/i;
const HTTP_SKIP_RE = /^\/api\/(?:health|healthz|ready|live|metrics|version|telemetry)(?:\/|$)|^\/(?:health|healthz|ready|live|metrics)(?:\/|$)/;

let storeInstance = null;
let pending = new Map();
const lastEventAt = new Map();
const known = new Set();
let flushTimer = null;
let flushing = null;
let capturing = false;
let newIssueWindow = { startedAt: 0, count: 0 };
const counters = { captured: 0, noise: 0, capped: 0, bursts: 0, flushed: 0 };
const installed = { console: false };
let commitCache;

function enabled(env = process.env) {
  const flag = String(env.SIRAGPT_SYSTEM_ERRORS ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  return env.NODE_ENV !== 'test';
}

function getStore() {
  if (!storeInstance) storeInstance = createSystemIssueStore();
  return storeInstance;
}

function __setStoreForTests(store) {
  storeInstance = store || null;
}

function __resetForTests() {
  pending = new Map();
  lastEventAt.clear();
  known.clear();
  newIssueWindow = { startedAt: 0, count: 0 };
  for (const key of Object.keys(counters)) counters[key] = 0;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  flushing = null;
  capturing = false;
}

function appCommit() {
  if (commitCache !== undefined) return commitCache;
  try {
    // eslint-disable-next-line global-require
    const { resolveCommit } = require('../../../utils/deployed-tree-commit');
    commitCache = resolveCommit(process.env, { cwd: path.resolve(__dirname, '..', '..', '..', '..', '..') }) || null;
  } catch (_) {
    commitCache = process.env.GIT_COMMIT || null;
  }
  if (typeof commitCache === 'string') commitCache = commitCache.slice(0, 12);
  return commitCache;
}

function environment() {
  return process.env.SIRAGPT_ENVIRONMENT || process.env.NODE_ENV || 'production';
}

function cleanId(value, max = 150) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return /^[A-Za-z0-9:_\-.]+$/.test(text) ? text.slice(0, max) : null;
}

function maskPath(p) {
  return String(p || '')
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id')
    .replace(/\/c[a-z0-9]{20,30}(?=\/|$)/g, '/:id')
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/:id')
    .replace(/\/\d{3,}(?=\/|$)/g, '/:id')
    .slice(0, 200);
}

function routeOf(req) {
  if (!req) return null;
  if (req.route && typeof req.route.path === 'string') return `${req.baseUrl || ''}${req.route.path}`.slice(0, 200);
  return maskPath(req.originalUrl || req.url || '');
}

function contextFromReq(req) {
  if (!req) return null;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  return {
    reqId: cleanId(req.requestId || req.id || (req.headers && req.headers['x-request-id'])),
    method: req.method ? String(req.method).toUpperCase() : null,
    route: routeOf(req),
    userId: req.user ? cleanId(req.user.id || req.user.userId) : null,
    chatId: cleanId(body.chatId) || cleanId(req.params && req.params.chatId),
    req,
  };
}

/** The request being served when the error was logged (logger ALS). */
function requestContext() {
  try {
    // eslint-disable-next-line global-require
    const { currentContext } = require('../../../utils/logger');
    const store = typeof currentContext === 'function' ? currentContext() : null;
    if (!store) return null;
    const req = store.__sysReq || null;
    const fromReq = contextFromReq(req);
    return {
      ...(fromReq || {}),
      reqId: (fromReq && fromReq.reqId) || cleanId(store.reqId || store.requestId),
      userId: (fromReq && fromReq.userId) || cleanId(store.userId),
    };
  } catch (_) {
    return null;
  }
}

function safeStringify(value) {
  if (value == null) return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s.slice(0, 1500);
  } catch (_) {
    try { return String(value); } catch (_e) { return '[unserializable]'; }
  }
}

function isErrorLike(v) {
  return v instanceof Error || Boolean(v && typeof v === 'object' && typeof v.message === 'string' && typeof v.stack === 'string');
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function noteOnTurn(fp, title) {
  try {
    // eslint-disable-next-line global-require
    const turnFailures = require('../turn-failures');
    if (turnFailures.currentTurn && turnFailures.currentTurn()) turnFailures.noteTurn('system_error', { fingerprint: fp, title });
  } catch (_) { /* advisory */ }
}

/**
 * Capture one error event.
 * @param {object} input { source, kind?, level?, name?, message, stack?, status?, queue?, tag?,
 *   ctx? (request context; default: the current request), extra?, page?, browser?, component? }
 * @returns {{ fingerprint: string, title: string } | null}
 */
function capture(input = {}) {
  if (!enabled() || capturing) return null;
  capturing = true;
  try {
    const message = String(input.message || '').trim();
    const text = `${input.name || ''} ${message} ${input.stack ? String(input.stack).split('\n').slice(0, 2).join(' ') : ''}`;
    if (fingerprint.isNoise({ text, status: input.status, source: input.source })) {
      counters.noise += 1;
      return null;
    }
    const ctx = input.ctx !== undefined ? input.ctx : requestContext();
    const d = fingerprint.describeEvent({
      kind: input.kind,
      level: input.level,
      name: input.name,
      message,
      stack: input.stack,
      tag: input.tag,
      route: input.kind === 'http' && ctx ? ctx.route : undefined,
      method: input.kind === 'http' && ctx ? ctx.method : undefined,
      status: input.status,
      queue: input.queue,
    });
    const t = Date.now();
    const fp = d.fingerprint;

    let entry = pending.get(fp);
    if (!entry && !known.has(fp)) {
      if (t - newIssueWindow.startedAt > 60_000) newIssueWindow = { startedAt: t, count: 0 };
      if (newIssueWindow.count >= MAX_NEW_ISSUES_PER_MIN) {
        counters.capped += 1;
        return null;
      }
      newIssueWindow.count += 1;
    }
    if (!entry) {
      entry = {
        fingerprint: fp,
        title: d.title,
        culprit: d.culprit,
        kind: d.kind,
        kindLabel: d.kindLabel,
        level: d.level,
        count: 0,
        lines: 0,
        hours: {},
        users: new Set(),
        reqIds: new Set(),
        chatIds: new Set(),
        samples: [],
        firstAt: t,
        lastAt: t,
        environment: environment(),
        commit: appCommit(),
      };
      pending.set(fp, entry);
      if (known.size >= MAX_TRACKED_FINGERPRINTS) known.clear();
      known.add(fp);
    }
    entry.lines += 1;
    entry.lastAt = t;
    if (d.level === 'fatal' || (d.level === 'error' && entry.level === 'warning')) entry.level = d.level;
    if (ctx && ctx.userId) entry.users.add(ctx.userId);
    if (ctx && ctx.reqId) entry.reqIds.add(ctx.reqId);
    if (ctx && ctx.chatId) entry.chatIds.add(ctx.chatId);

    const last = lastEventAt.get(fp) || 0;
    let sample = null;
    if (t - last >= BURST_WINDOW_MS) {
      // A new event. Repeats inside the burst window collapse into it.
      lastEventAt.set(fp, t);
      if (lastEventAt.size > MAX_TRACKED_FINGERPRINTS) lastEventAt.delete(lastEventAt.keys().next().value);
      entry.count += 1;
      const hk = hourKey(t);
      entry.hours[hk] = (entry.hours[hk] || 0) + 1;
      if (entry.samples.length < MAX_SAMPLES_PER_FLUSH) {
        sample = {
          at: new Date(t).toISOString(),
          level: d.level,
          source: input.source || 'console',
          message: fingerprint.redactMultiline(message, 1500),
          stack: input.stack ? fingerprint.redactMultiline(input.stack, 4000) : null,
          topFrame: d.topFrame ? { fn: d.topFrame.fn, file: d.topFrame.file, line: d.topFrame.line } : null,
          route: ctx ? ctx.route || null : null,
          method: ctx ? ctx.method || null : null,
          status: Number(input.status) || null,
          reqId: ctx ? ctx.reqId || null : null,
          userId: ctx ? ctx.userId || null : null,
          chatId: ctx ? ctx.chatId || null : null,
          queue: input.queue || null,
          tag: d.tag,
          page: input.page ? fingerprint.redactLine(input.page, 300) : null,
          component: input.component ? fingerprint.redactLine(input.component, 160) : null,
          browser: input.browser ? fingerprint.redactLine(input.browser, 200) : null,
          environment: entry.environment,
          commit: entry.commit,
          host: os.hostname(),
          burst: 1,
        };
        entry.samples.push(sample);
      }
    } else {
      counters.bursts += 1;
      const lastSample = entry.samples[entry.samples.length - 1];
      if (lastSample) lastSample.burst = (Number(lastSample.burst) || 1) + 1;
    }
    // The HTTP 5xx hook reuses this event instead of writing a second one.
    if (ctx && ctx.req && d.level !== 'warning') {
      try {
        ctx.req.__systemErrorCaptured = fp;
        if (sample) ctx.req.__systemErrorSample = sample;
      } catch (_) { /* frozen req in tests */ }
    }
    counters.captured += 1;
    scheduleFlush();
    noteOnTurn(fp, d.title);
    return { fingerprint: fp, title: d.title };
  } catch (_) {
    return null;
  } finally {
    capturing = false;
  }
}

function writeBatch(batch) {
  return (async () => {
    const results = [];
    for (const entry of batch) {
      // eslint-disable-next-line no-await-in-loop
      const res = await getStore().recordIssue({
        ...entry,
        users: [...entry.users],
        reqIds: [...entry.reqIds],
        chatIds: [...entry.chatIds],
      }).catch(() => ({}));
      results.push({ fingerprint: entry.fingerprint, ...res });
      counters.flushed += 1;
    }
    return results;
  })();
}

/**
 * Persist pending aggregates (timer, shutdown, tests). Waits for a flush in
 * progress, then drains what was captured meanwhile — bounded, so an error
 * loop (a failing DB logging its own failures) can never spin forever.
 */
async function flush() {
  const results = [];
  for (let round = 0; round < 3; round += 1) {
    if (flushing) {
      // eslint-disable-next-line no-await-in-loop
      await flushing.catch(() => []);
      continue;
    }
    if (!pending.size) break;
    const batch = [...pending.values()];
    pending = new Map();
    flushing = writeBatch(batch).finally(() => { flushing = null; });
    // eslint-disable-next-line no-await-in-loop
    results.push(...(await flushing.catch(() => [])));
  }
  if (pending.size) scheduleFlush();
  return results;
}

// ── Capture entry points ──────────────────────────────────────────────

function captureConsole(level, args = []) {
  if (!enabled() || capturing || !Array.isArray(args) || !args.length) return null;
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (CONSOLE_SKIP_RE.test(first)) return null;
  const errArg = args.find(isErrorLike) || null;
  const text = args.map((a) => (isErrorLike(a) ? `${a.name || 'Error'}: ${a.message}` : safeStringify(a))).join(' ');
  if (level === 'warning' && !WARN_CAPTURE_RE.test(text)) return null;
  const tag = fingerprint.logTagOf(first);
  let message = text;
  if (errArg) {
    // Keep the log prefix («[doc-engine] worker error:») with the error text.
    const prefix = args.filter((a) => typeof a === 'string' && a !== errArg.message).join(' ').trim();
    message = prefix ? `${prefix} ${errArg.message}` : errArg.message;
  }
  return capture({
    source: 'console',
    level: level === 'warning' ? 'warning' : 'error',
    name: errArg ? errArg.name : null,
    message,
    stack: errArg ? errArg.stack : null,
    tag,
  });
}

function captureFatal(error, origin = 'uncaughtException') {
  const isErr = isErrorLike(error);
  const message = isErr ? error.message : safeStringify(error);
  const detected = fingerprint.detectKind(`${isErr ? error.name : ''} ${message}`, null);
  const out = capture({
    source: origin === 'uncaughtException' ? 'exception' : 'rejection',
    kind: detected || (origin === 'uncaughtException' ? 'excepcion' : 'promesa'),
    level: origin === 'uncaughtException' ? 'fatal' : 'error',
    name: isErr ? error.name : null,
    message,
    stack: isErr ? error.stack : null,
  });
  // The process may exit right after an uncaught exception: write now.
  if (origin === 'uncaughtException') void flush();
  return out;
}

/** Express global error handler (next(err) / thrown in a route). */
function captureRequestError(err, { req = null, tags = {} } = {}) {
  const status = Number(tags && tags.status) || Number(err && (err.status || err.statusCode)) || 500;
  if (status < 500) return null;
  return capture({
    source: 'express',
    level: 'error',
    name: err && err.name,
    message: (err && err.message) || safeStringify(err),
    stack: err && err.stack,
    status,
    ctx: contextFromReq(req),
  });
}

// Browser noise nobody can fix server-side: extension scripts, opaque
// cross-origin «Script error.», ResizeObserver loops, stale chunks right
// after a deploy (the page reloads itself), aborted fetches.
const FRONTEND_NOISE_RE = /ResizeObserver loop|^\s*Script error\.?\s*$|Non-Error promise rejection captured|ChunkLoadError|Loading (?:CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|NetworkError when attempting to fetch|^\s*(?:TypeError: )?(?:Failed to fetch|Load failed|cancelled)\s*$|The (?:operation|user) (?:was )?aborted|(?:chrome|moz|safari(?:-web)?)-extension:\/\//i;

/** Frontend errors posted to /api/telemetry/error (already sanitized). */
function captureFrontendEvent(event = {}, req = null) {
  const source = String(event.source || 'client');
  // API failures are captured server-side (5xx) or expected (4xx);
  // network blips are the user's connection.
  if (source === 'api' || source === 'network') return null;
  if (event.severity === 'warn' || event.severity === 'info') return null;
  if (FRONTEND_NOISE_RE.test(String(event.message || '')) || FRONTEND_NOISE_RE.test(String(event.stack || ''))) {
    counters.noise += 1;
    return null;
  }
  const ctx = contextFromReq(req) || {};
  return capture({
    source: 'frontend',
    kind: 'frontend',
    level: event.severity === 'fatal' ? 'fatal' : 'error',
    message: event.message || 'Error del navegador',
    stack: event.stack || null,
    tag: event.component || null,
    page: event.page || null,
    component: event.component || null,
    browser: event.browser || null,
    ctx: { ...ctx, route: event.page ? maskPath(String(event.page).replace(/^https?:\/\/[^/]+/, '')) : null, method: null },
  });
}

/**
 * Early middleware: binds the request to the logger's ALS context (so a
 * console.error while serving it carries route / reqId / user) and records
 * a 5xx answer that no error capture explained yet.
 */
function httpMiddleware() {
  return function systemErrorsHttp(req, res, next) {
    if (!enabled()) return next();
    try {
      // eslint-disable-next-line global-require
      const { currentContext } = require('../../../utils/logger');
      const store = typeof currentContext === 'function' ? currentContext() : null;
      if (store && !store.__sysReq) Object.defineProperty(store, '__sysReq', { value: req, enumerable: false, configurable: true });
    } catch (_) { /* advisory */ }
    const url = String(req.originalUrl || req.url || '');
    if (HTTP_SKIP_RE.test(url)) return next();
    let jsonBody = null;
    if (typeof res.json === 'function') {
      const prevJson = res.json;
      res.json = function systemErrorsJson(body) {
        try { jsonBody = body && typeof body === 'object' ? body : null; } catch (_) { /* advisory */ }
        return prevJson.call(this, body);
      };
    }
    res.on('finish', () => {
      try {
        const status = Number(res.statusCode);
        if (!(status >= 500)) return;
        if (req.__systemErrorCaptured) {
          const sample = req.__systemErrorSample;
          if (sample && !sample.status) sample.status = status;
          return;
        }
        const body = jsonBody || {};
        const message = typeof body.error === 'string' ? body.error
          : typeof body.message === 'string' ? body.message
            : `HTTP ${status}`;
        capture({ source: 'http', kind: 'http', level: 'error', message, status, ctx: contextFromReq(req) });
      } catch (_) { /* advisory */ }
    });
    return next();
  };
}

/**
 * Wrap console.error / console.warn once (after index.js's own console
 * shaping). The original output is always written first.
 */
function installConsoleCapture(target = console) {
  if (installed.console || !target) return false;
  installed.console = true;
  const origError = target.error;
  const origWarn = target.warn;
  target.error = function systemErrorsConsoleError(...args) {
    origError.apply(target, args);
    try { captureConsole('error', args); } catch (_) { /* never */ }
  };
  target.warn = function systemErrorsConsoleWarn(...args) {
    origWarn.apply(target, args);
    try { captureConsole('warning', args); } catch (_) { /* never */ }
  };
  return true;
}

function snapshot() {
  return { enabled: enabled(), pending: pending.size, known: known.size, ...counters };
}

module.exports = {
  enabled,
  capture,
  captureConsole,
  captureFatal,
  captureRequestError,
  captureFrontendEvent,
  httpMiddleware,
  installConsoleCapture,
  flush,
  snapshot,
  getStore,
  contextFromReq,
  __setStoreForTests,
  __resetForTests,
  fingerprint,
  WARN_CAPTURE_RE,
};
