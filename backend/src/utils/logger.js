'use strict';

/**
 * logger — Unified logging helper with AsyncLocalStorage context binding.
 *
 * Wraps the project's existing pino instance (backend/src/middleware/logger.js)
 * when pino is installed, falling back to a console-based shim otherwise.
 * Every call automatically injects the active request id (`reqId`) when an
 * `AsyncLocalStorage` context is bound via `runWithContext()`. This lets
 * deep service code call `log.info({...}, 'msg')` and still emit correlated
 * lines without threading a `req` argument through every function.
 *
 * Levels: trace, debug, info, warn, error, fatal.
 *
 * In development (`NODE_ENV !== 'production'`) the fallback shim adds
 * lightweight ANSI color coding so dev runs are readable; production
 * always emits structured JSON so log aggregators stay happy.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const LEVEL_VALUE = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const IS_PROD = process.env.NODE_ENV === 'production';

const ALS = new AsyncLocalStorage();

function runWithContext(ctx, fn) {
  return ALS.run({ ...(ctx || {}) }, fn);
}

function currentContext() {
  return ALS.getStore() || null;
}

function setContextField(key, value) {
  const store = ALS.getStore();
  if (store) store[key] = value;
}

// ANSI color codes — only used by the console fallback in dev.
const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

const LEVEL_COLOR = {
  trace: COLORS.gray,
  debug: COLORS.cyan,
  info: COLORS.green,
  warn: COLORS.yellow,
  error: COLORS.red,
  fatal: COLORS.magenta,
};

function consoleEmit(level, payload, msg) {
  const out = IS_PROD ? process.stdout : process.stderr;
  const timestamp = new Date().toISOString();
  if (IS_PROD) {
    const line = JSON.stringify({
      level: LEVEL_VALUE[level],
      time: Date.now(),
      ...payload,
      msg,
    });
    out.write(line + '\n');
  } else {
    const color = LEVEL_COLOR[level] || '';
    const tag = `${color}${level.toUpperCase().padEnd(5)}${COLORS.reset}`;
    const rid = payload.reqId ? ` ${COLORS.gray}[${payload.reqId}]${COLORS.reset}` : '';
    const extras = Object.keys(payload).filter((k) => k !== 'reqId');
    const tail = extras.length ? ' ' + JSON.stringify(Object.fromEntries(extras.map((k) => [k, payload[k]]))) : '';
    out.write(`${COLORS.gray}${timestamp}${COLORS.reset} ${tag}${rid} ${msg || ''}${tail}\n`);
  }
}

function tryLoadPino() {
  try {
    // Prefer the project logger so redaction + OTel mixin stay in effect.
    // eslint-disable-next-line global-require
    const middleware = require('../middleware/logger');
    if (middleware && middleware.logger) return middleware.logger;
  } catch (_e) {
    // fall through to direct pino, then to console.
  }
  try {
    // eslint-disable-next-line global-require
    const pino = require('pino');
    return pino({ level: process.env.LOG_LEVEL || 'info' });
  } catch (_e) {
    return null;
  }
}

const basePino = tryLoadPino();

function normalizeArgs(arg1, arg2) {
  // Mirrors pino's overloads: log.info(obj, msg) or log.info(msg).
  if (typeof arg1 === 'string') return { payload: {}, msg: arg1 };
  if (arg1 instanceof Error) {
    return {
      payload: { err: { name: arg1.name, message: arg1.message, stack: arg1.stack } },
      msg: typeof arg2 === 'string' ? arg2 : arg1.message,
    };
  }
  if (arg1 && typeof arg1 === 'object') {
    return { payload: { ...arg1 }, msg: typeof arg2 === 'string' ? arg2 : undefined };
  }
  return { payload: {}, msg: typeof arg2 === 'string' ? arg2 : String(arg1 ?? '') };
}

function withContext(payload) {
  const ctx = ALS.getStore();
  if (!ctx) return payload;
  const out = { ...payload };
  if (ctx.reqId && out.reqId === undefined) out.reqId = ctx.reqId;
  if (ctx.userId && out.userId === undefined) out.userId = ctx.userId;
  if (ctx.sessionId && out.sessionId === undefined) out.sessionId = ctx.sessionId;
  return out;
}

function buildLogger(bindings) {
  const child = basePino && typeof basePino.child === 'function' && bindings
    ? basePino.child(bindings)
    : basePino;

  const api = {};
  for (const level of LEVELS) {
    api[level] = function emit(arg1, arg2) {
      const { payload, msg } = normalizeArgs(arg1, arg2);
      const enriched = withContext({ ...(bindings || {}), ...payload });
      if (child && typeof child[level] === 'function') {
        if (msg === undefined) child[level](enriched);
        else child[level](enriched, msg);
        return;
      }
      // Fallback path — no pino available.
      consoleEmit(level, enriched, msg);
    };
  }
  api.child = (extra) => buildLogger({ ...(bindings || {}), ...(extra || {}) });
  return api;
}

const logger = buildLogger();

module.exports = {
  logger,
  buildLogger,
  runWithContext,
  currentContext,
  setContextField,
  ALS,
  LEVELS,
};
