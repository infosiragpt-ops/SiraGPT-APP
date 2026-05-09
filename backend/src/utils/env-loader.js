'use strict';

/**
 * env-loader — typed loader/validator for process.env. Caller passes
 * a schema { KEY: { type, required, default, choices, parser, secret } }
 * and gets back a frozen typed object. Fails loud at boot if any
 * required var is missing or any value fails its parser, so a
 * mistyped DATABASE_URL surfaces immediately instead of crashing
 * the first request.
 *
 * Pairs with the credential resolver (#11) and feature flags (#37):
 * those handle dynamic / per-request config; this one is the
 * canonical place for boot-time process config.
 *
 * Supported types:
 *   'string'  — passthrough
 *   'number'  — Number(); rejects NaN
 *   'integer' — Number.isInteger required
 *   'boolean' — '1/true/yes/on' true; '0/false/no/off' false
 *   'json'    — JSON.parse
 *   'list'    — split by comma; trims; drops empties
 *   'enum'    — must be in `choices`
 *   custom    — pass `parser: (raw) => value`
 *
 * Public API:
 *   loadEnv(schema, env = process.env) → frozen object
 *   EnvValidationError                 — exported error class
 *   describeSchema(schema)             — markdown table summary
 */

class EnvValidationError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'EnvValidationError';
    this.errors = errors || [];
  }
}

const TRUE = new Set(['1', 'true', 'yes', 'on', 't', 'y']);
const FALSE = new Set(['0', 'false', 'no', 'off', 'f', 'n']);

function coerce(rawValue, def) {
  const t = def.type;
  if (typeof def.parser === 'function') return def.parser(rawValue);
  if (t === 'string') return rawValue;
  if (t === 'number' || t === 'integer') {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) throw new Error(`expected number, got "${rawValue}"`);
    if (t === 'integer' && !Number.isInteger(n)) throw new Error(`expected integer, got "${rawValue}"`);
    return n;
  }
  if (t === 'boolean') {
    const s = String(rawValue).trim().toLowerCase();
    if (TRUE.has(s)) return true;
    if (FALSE.has(s)) return false;
    throw new Error(`expected boolean, got "${rawValue}"`);
  }
  if (t === 'json') {
    return JSON.parse(rawValue);
  }
  if (t === 'list') {
    return String(rawValue).split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (t === 'enum') {
    if (!Array.isArray(def.choices) || !def.choices.includes(rawValue)) {
      throw new Error(`expected one of ${JSON.stringify(def.choices)}, got "${rawValue}"`);
    }
    return rawValue;
  }
  throw new Error(`unknown type "${t}"`);
}

function loadEnv(schema, env = process.env) {
  if (!schema || typeof schema !== 'object') throw new TypeError('env-loader: schema required');
  const out = {};
  const errors = [];
  for (const [key, def] of Object.entries(schema)) {
    if (!def || typeof def !== 'object') {
      errors.push({ key, error: 'invalid schema entry' });
      continue;
    }
    const present = Object.prototype.hasOwnProperty.call(env, key) && env[key] !== '';
    let raw;
    if (present) {
      raw = env[key];
    } else if (def.required) {
      errors.push({ key, error: 'required env var is missing' });
      continue;
    } else if (Object.prototype.hasOwnProperty.call(def, 'default')) {
      out[key] = def.default;
      continue;
    } else {
      out[key] = undefined;
      continue;
    }
    try {
      out[key] = coerce(raw, def);
    } catch (e) {
      errors.push({ key, error: e.message });
    }
  }
  if (errors.length) {
    const summary = errors.map((e) => `${e.key}: ${e.error}`).join('; ');
    throw new EnvValidationError(`env-loader: ${errors.length} error(s) — ${summary}`, errors);
  }
  return Object.freeze(out);
}

function describeSchema(schema) {
  const rows = ['| key | type | required | default |', '| --- | --- | --- | --- |'];
  for (const [k, d] of Object.entries(schema || {})) {
    const def = d || {};
    const def0 = Object.prototype.hasOwnProperty.call(def, 'default')
      ? (def.secret ? '«secret»' : JSON.stringify(def.default))
      : '—';
    rows.push(`| ${k} | ${def.type || '?'} | ${def.required ? 'yes' : 'no'} | ${def0} |`);
  }
  return rows.join('\n');
}

module.exports = {
  loadEnv,
  describeSchema,
  EnvValidationError,
  coerce,
};
