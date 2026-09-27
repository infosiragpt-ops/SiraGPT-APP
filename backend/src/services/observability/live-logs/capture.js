'use strict';

/**
 * live-logs/capture — see everything the backend prints.
 *
 * Hooks (installed once, as early as possible in index.js):
 *   - process.stdout.write / process.stderr.write — every console.* call and
 *     every library that writes to the process streams;
 *   - console.error/warn/info/log/debug/trace — only to remember WHICH method
 *     produced the next write (console.error → error level);
 *   - pino (middleware/logger.js) via its `streamWrite` hook — pino writes to
 *     fd 1 through sonic-boom and bypasses process.stdout.write.
 *
 * Each write becomes one structured, redacted event with the request context
 * of the code that logged it (AsyncLocalStorage from utils/logger.js):
 * reqId, user, route, chatId — or the queue/job for worker code.
 *
 * Hard rule: capturing must never change what is printed, never throw and
 * never block. The original write always runs, unchanged.
 */

const { classifyLine } = require('./classify');
const { redactText } = require('./redact');

const CONSOLE_METHODS = ['error', 'warn', 'info', 'log', 'debug', 'trace'];
const MAX_CHUNK_CHARS = 64 * 1024;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g; // eslint-disable-line no-control-regex

const state = {
  installed: false,
  enabled: true,
  inCapture: false,
  pendingMethod: null,
  sink: null,
  commit: null,
  originalStderrWrite: null,
  originalStdoutWrite: null,
  contextModule: undefined,
  // Resolving the request context requires utils/logger (pino). Wait until
  // index.js finished its synchronous boot so we never change module load order.
  contextAllowed: false,
  // pino writes each line through `hooks.streamWrite` (tapped) and then to its
  // stream. When stdout was hooked before pino loaded, pino detects the
  // "tampered" stdout and writes through process.stdout.write too — the
  // stream hook skips that identical chunk so every pino line is ONE event.
  lastPinoLine: null,
  lastNoteAt: 0,
};

function resolveCommit(env = process.env) {
  const raw = String(env.GIT_COMMIT || env.SOURCE_COMMIT || env.SIRAGPT_VERSION || env.COMMIT_SHA || '').trim();
  if (!raw) return null;
  const m = /[0-9a-f]{7,40}/i.exec(raw);
  return (m ? m[0].slice(0, 8) : raw.slice(0, 12)).toLowerCase();
}

// userId → email learned from lines that carry both (request context), so
// lines that only know the user id (request-logger, workers) show the email.
const EMAIL_CACHE_MAX = 1000;
const emailByUser = new Map();

function rememberEmail(userId, email) {
  if (!userId || !email) return;
  if (emailByUser.has(userId)) emailByUser.delete(userId);
  emailByUser.set(userId, email);
  if (emailByUser.size > EMAIL_CACHE_MAX) emailByUser.delete(emailByUser.keys().next().value);
}

/** Internal diagnostics go straight to stderr, never back into the capture. */
function internalNote(text) {
  const now = Date.now();
  if (now - state.lastNoteAt < 60_000) return;
  state.lastNoteAt = now;
  try {
    const write = state.originalStderrWrite || process.stderr.write.bind(process.stderr);
    write(`[live-logs] ${text}\n`);
  } catch (_) { /* ignore */ }
}

function loggerContextModule() {
  if (!state.contextAllowed) return null;
  if (state.contextModule !== undefined) return state.contextModule;
  state.contextModule = null;
  try {
    // eslint-disable-next-line global-require
    const mod = require('../../../utils/logger');
    if (mod && typeof mod.currentContext === 'function') state.contextModule = mod;
  } catch (_) {
    state.contextModule = null;
  }
  return state.contextModule;
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

function routeOf(req) {
  try {
    const method = String(req.method || '').toUpperCase();
    const pattern = req.route && typeof req.route.path === 'string' ? `${req.baseUrl || ''}${req.route.path}` : '';
    const raw = pattern || String(req.originalUrl || req.url || '').split('?')[0];
    return `${method} ${raw}`.trim().slice(0, 160);
  } catch (_) {
    return null;
  }
}

/** Request/job context of the code that is logging right now. */
function readContext() {
  const mod = loggerContextModule();
  if (!mod) return null;
  let store = null;
  try { store = mod.currentContext(); } catch (_) { store = null; }
  if (!store || typeof store !== 'object') return null;
  const ctx = {};
  const reqId = firstString(store.reqId, store.requestId, store.request_id);
  if (reqId) ctx.reqId = reqId.slice(0, 128);
  const req = store.__liveLogsReq;
  if (req && typeof req === 'object') {
    const user = req.user;
    if (user && typeof user === 'object') {
      const userId = firstString(user.id, user.userId);
      if (userId) ctx.userId = userId.slice(0, 64);
      if (typeof user.email === 'string' && user.email) ctx.email = user.email.slice(0, 120);
    }
    const route = routeOf(req);
    if (route) ctx.route = route;
    const params = req.params || {};
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const query = req.query && typeof req.query === 'object' ? req.query : {};
    const chatId = firstString(params.chatId, body.chatId, query.chatId, body.conversationId, query.conversationId);
    if (chatId) ctx.chatId = chatId.slice(0, 64);
  }
  const queue = firstString(store.queue, store.queueName);
  if (queue) ctx.queue = queue.slice(0, 60);
  const jobId = firstString(store.jobId);
  if (jobId) ctx.jobId = jobId.slice(0, 80);
  if (!ctx.userId && store.userId) ctx.userId = String(store.userId).slice(0, 64);
  if (!ctx.chatId && store.chatId) ctx.chatId = String(store.chatId).slice(0, 64);
  return Object.keys(ctx).length ? ctx : null;
}

function chunkToText(chunk, encoding) {
  if (chunk == null) return '';
  if (typeof chunk === 'string') return chunk.length > MAX_CHUNK_CHARS ? chunk.slice(0, MAX_CHUNK_CHARS) : chunk;
  if (chunk instanceof Uint8Array) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const enc = typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8';
    return buf.toString(enc, 0, Math.min(buf.length, MAX_CHUNK_CHARS));
  }
  return '';
}

/** Build + hand one event to the sink. Exported for tests and the pino tap. */
function captureText(text, method = 'stdout') {
  if (!state.enabled || !state.sink || typeof text !== 'string' || !text) return null;
  const clean = text.replace(ANSI_RE, '');
  if (!clean.trim()) return null;
  // Our own diagnostics never re-enter the stream (no feedback loop).
  if (clean.startsWith('[live-logs] ')) return null;
  const ctx = readContext();
  const redacted = redactText(clean);
  const cls = classifyLine({ text: redacted, method, ctx });
  if (!cls || cls.drop) return null;
  const jc = cls.jsonCtx || {};
  const userId = (ctx && ctx.userId) || jc.userId || null;
  let email = (ctx && ctx.email) || null;
  if (userId && email) rememberEmail(userId, email);
  else if (userId && !email) email = emailByUser.get(userId) || null;
  const event = {
    ts: Date.now(),
    level: cls.level,
    source: cls.source,
    tag: cls.tag,
    msg: cls.msg,
    body: cls.body && cls.body !== cls.msg ? cls.body : null,
    status: cls.status,
    reqId: (ctx && ctx.reqId) || jc.reqId || null,
    userId,
    email,
    chatId: (ctx && ctx.chatId) || jc.chatId || null,
    route: (ctx && ctx.route) || null,
    queue: (ctx && ctx.queue) || null,
    jobId: (ctx && ctx.jobId) || null,
    commit: state.commit,
    via: method,
  };
  return state.sink(event);
}

function hookStream(stream, name) {
  if (!stream || typeof stream.write !== 'function') return null;
  if (stream.write.__liveLogsHooked) return stream.write.__liveLogsOriginal;
  const original = stream.write.bind(stream);
  const hooked = function liveLogsWrite(chunk, encoding, callback) {
    if (!state.inCapture && state.enabled && state.sink) {
      state.inCapture = true;
      try {
        const text = chunkToText(chunk, encoding);
        if (state.lastPinoLine !== null && text === state.lastPinoLine) {
          state.lastPinoLine = null; // already captured by the pino tap
        } else {
          captureText(text, state.pendingMethod || name);
        }
      } catch (_) {
        /* never break the write */
      } finally {
        state.inCapture = false;
      }
    }
    return original(chunk, encoding, callback);
  };
  hooked.__liveLogsHooked = true;
  hooked.__liveLogsOriginal = original;
  stream.write = hooked;
  return original;
}

function hookConsole() {
  for (const method of CONSOLE_METHODS) {
    const original = console[method];
    if (typeof original !== 'function' || original.__liveLogsHooked) continue;
    const tagged = `console.${method}`;
    const wrapped = function liveLogsConsole(...args) {
      const previous = state.pendingMethod;
      state.pendingMethod = tagged;
      try {
        return original.apply(console, args);
      } finally {
        state.pendingMethod = previous;
      }
    };
    wrapped.__liveLogsHooked = true;
    console[method] = wrapped;
  }
}

/** pino `hooks.streamWrite` tap: observe the serialized line, return it unchanged. */
function tapPinoLine(line) {
  if (state.inCapture || !state.enabled || !state.sink) return line;
  state.inCapture = true;
  try {
    const text = typeof line === 'string' ? line : String(line);
    state.lastPinoLine = text;
    captureText(text, 'pino');
  } catch (_) {
    /* ignore */
  } finally {
    state.inCapture = false;
  }
  return line;
}

function install({ sink, env = process.env } = {}) {
  if (state.installed) return false;
  if (String(env.SIRAGPT_LIVE_LOGS || '').trim() === '0') {
    state.enabled = false;
    return false;
  }
  state.installed = true;
  state.sink = typeof sink === 'function' ? sink : null;
  state.commit = resolveCommit(env);
  state.originalStdoutWrite = hookStream(process.stdout, 'stdout');
  state.originalStderrWrite = hookStream(process.stderr, 'stderr');
  hookConsole();
  const allow = () => { state.contextAllowed = true; };
  if (typeof setImmediate === 'function') setImmediate(allow);
  else allow();
  return true;
}

function setEnabled(value) {
  state.enabled = Boolean(value);
}

module.exports = {
  install,
  captureText,
  tapPinoLine,
  readContext,
  resolveCommit,
  internalNote,
  setEnabled,
  _state: state,
  _hookStream: hookStream,
  _emailByUser: emailByUser,
};
