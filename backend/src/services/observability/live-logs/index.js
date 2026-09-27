'use strict';

/**
 * live-logs — «Registros en vivo» for Admin → Logs.
 *
 * Captures every line the backend prints (console, process streams, pino),
 * redacts secrets, tags it with the request/job context, keeps it in a ring
 * buffer + the local Redis, and streams it to admins over SSE.
 *
 *   install()                     hook the process streams (call first thing in index.js)
 *   start()                       open the Redis sink (after env is loaded)
 *   requestContextMiddleware      mount after request-id so lines carry user/route/chat
 *   runWithLogContext(ctx, fn)    run worker code with {queue, jobId, userId, chatId}
 *   getRequestLogs(reqId)         every stored line of one request/turn, oldest first
 *   getStore()                    the LiveLogStore (live bus, recent(), search())
 *
 * Env: SIRAGPT_LIVE_LOGS=0 disables everything; SIRAGPT_LIVE_LOGS_REDIS=0 keeps
 * it memory-only; sizing knobs in store.js (SIRAGPT_LIVE_LOGS_*).
 */

const capture = require('./capture');
const { LiveLogStore } = require('./store');

let store = null;

function getStore() {
  if (!store) {
    store = new LiveLogStore({});
    store.internalNote = capture.internalNote;
  }
  return store;
}

function install({ env = process.env } = {}) {
  const s = getStore();
  return capture.install({ env, sink: (event) => s.push(event) });
}

function start({ env = process.env } = {}) {
  if (String(env.SIRAGPT_LIVE_LOGS || '').trim() === '0') return false;
  getStore().start();
  return true;
}

function loggerModule() {
  try {
    // eslint-disable-next-line global-require
    return require('../../../utils/logger');
  } catch (_) {
    return null;
  }
}

/** Remember the Express request in the logging context (user/route/chat resolved lazily). */
function requestContextMiddleware(req, _res, next) {
  try {
    const mod = loggerModule();
    if (mod && typeof mod.setContextField === 'function') mod.setContextField('__liveLogsReq', req);
  } catch (_) { /* never block a request */ }
  next();
}

/** Run worker/job code so its log lines carry `{queue, jobId, userId, chatId, reqId}`. */
function runWithLogContext(ctx, fn) {
  const mod = loggerModule();
  if (!mod || typeof mod.runWithContext !== 'function') return fn();
  const current = typeof mod.currentContext === 'function' ? mod.currentContext() : null;
  return mod.runWithContext({ ...(current || {}), ...(ctx || {}) }, fn);
}

function getRequestLogs(reqId, opts) {
  return getStore().requestLines(reqId, opts);
}

module.exports = {
  install,
  start,
  getStore,
  requestContextMiddleware,
  runWithLogContext,
  getRequestLogs,
  tapPinoLine: capture.tapPinoLine,
};
