'use strict';

/**
 * structured-logger — JSON-line logger with leveled output, child
 * loggers (immutable bindings), PII redaction (reuses provider-audit
 * #14's defaultRedactor), and per-level sampling. Pluggable sink so
 * tests inspect lines without monkey-patching console.
 *
 * Why bespoke vs. pino: pino brings a worker thread + transport
 * machinery for ~80KB; we just want JSON-line + redact + child + a
 * level filter that integrates with the rest of this module set.
 *
 * Public API:
 *   const log = createStructuredLogger({
 *     level = 'info',
 *     bindings = {},                     // baked into every line
 *     sink = (line) => { console.log(line) },
 *     redactor,                          // (str) => str
 *     samplingRates,                     // { trace: 0.01, debug: 0.1, ... }
 *     now,
 *   })
 *   log.info(msg, fields?)               — and .trace/debug/warn/error/fatal
 *   log.child(extraBindings)             → new logger inheriting parent
 *   log.withRedactor(fn)                 → new logger with override redactor
 *   log.snapshot()                       → counters
 *
 * Each line is JSON: { ts, level, msg, ...bindings, ...fields }.
 * Field values are redacted before serialization (string fields and
 * deep object fields).
 */

const { defaultRedactor, deepRedact } = require('./provider-audit-log');

const LEVELS = Object.freeze(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const LEVEL_TO_INDEX = Object.fromEntries(LEVELS.map((lvl, i) => [lvl, i]));

const DEFAULT_LEVEL = 'info';

function levelOf(lvl) {
  return LEVEL_TO_INDEX[lvl];
}

function createStructuredLogger(opts = {}) {
  const level = LEVEL_TO_INDEX[opts.level] !== undefined ? opts.level : DEFAULT_LEVEL;
  const minIdx = LEVEL_TO_INDEX[level];
  const bindings = opts.bindings && typeof opts.bindings === 'object' ? { ...opts.bindings } : {};
  const sink = typeof opts.sink === 'function' ? opts.sink : (line) => { try { process.stdout.write(line + '\n'); } catch { /* swallow */ } };
  const redactor = typeof opts.redactor === 'function' ? opts.redactor : defaultRedactor;
  const samplingRates = (opts.samplingRates && typeof opts.samplingRates === 'object') ? opts.samplingRates : {};
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  const counters = { emitted: 0, dropped: 0, sampled: 0 };

  function shouldEmit(lvl) {
    if (LEVEL_TO_INDEX[lvl] < minIdx) return false;
    const rate = samplingRates[lvl];
    if (rate === undefined || rate >= 1) return true;
    if (rate <= 0) return false;
    if (rng() < rate) return true;
    counters.sampled += 1;
    return false;
  }

  function emit(lvl, msg, fields) {
    if (!shouldEmit(lvl)) { counters.dropped += 1; return; }
    const line = {
      ts: now(),
      level: lvl,
      msg: typeof msg === 'string' ? redactor(msg) : redactor(String(msg)),
      ...bindings,
    };
    if (fields && typeof fields === 'object') {
      for (const [k, v] of Object.entries(fields)) {
        line[k] = deepRedact(v, redactor);
      }
    }
    let serialized;
    try { serialized = JSON.stringify(line); }
    catch { serialized = JSON.stringify({ ts: line.ts, level: lvl, msg: '[unserializable]' }); }
    try { sink(serialized); } catch { /* swallow — logger must never crash caller */ }
    counters.emitted += 1;
  }

  const log = {
    trace: (msg, fields) => emit('trace', msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
    info:  (msg, fields) => emit('info',  msg, fields),
    warn:  (msg, fields) => emit('warn',  msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    fatal: (msg, fields) => emit('fatal', msg, fields),
    level: () => level,
    snapshot: () => ({ ...counters, level, bindings: { ...bindings } }),
    child(extra) {
      if (!extra || typeof extra !== 'object') return this;
      return createStructuredLogger({
        ...opts,
        bindings: { ...bindings, ...extra },
      });
    },
    withRedactor(fn) {
      return createStructuredLogger({ ...opts, redactor: fn });
    },
  };
  return log;
}

module.exports = {
  createStructuredLogger,
  LEVELS,
  levelOf,
};
