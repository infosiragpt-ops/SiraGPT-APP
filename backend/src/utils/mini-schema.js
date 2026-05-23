'use strict';

/**
 * mini-schema — small zod-style runtime schema library. Pairs with
 * the tool-args validator (#27, JSON Schema subset) but more
 * general: chainable, supports unions/literals/refinements, and
 * returns a typed `safeParse` result so callers branch on `ok`
 * instead of try/catch.
 *
 * Built-ins:
 *   s.string()        .min/.max/.regex/.refine
 *   s.number()        .int/.min/.max/.refine
 *   s.boolean()
 *   s.literal(v)
 *   s.array(item)     .min/.max
 *   s.object(shape)   .strict/.refine
 *   s.union(a, b, ...)
 *   s.optional(inner)
 *   s.nullable(inner)
 *
 * Each schema:
 *   parse(value)         → value (throws on invalid)
 *   safeParse(value)     → { ok: true, value } | { ok: false, errors }
 *   refine(fn, msg)      → new schema with extra constraint
 *
 * Errors are { path, message }; path is JSONPath-style ($, $.user.age).
 */

class SchemaError extends Error {
  constructor(errors) {
    super(`mini-schema: ${errors.length} error(s) — ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
    this.name = 'SchemaError';
    this.errors = errors;
  }
}

function makeSchema(check) {
  const s = {
    parse(value) {
      const r = this.safeParse(value);
      if (r.ok) return r.value;
      throw new SchemaError(r.errors);
    },
    safeParse(value) {
      const errors = [];
      const out = check(value, '$', errors);
      if (errors.length) return { ok: false, errors };
      return { ok: true, value: out };
    },
    refine(fn, msg = 'failed refinement') {
      return makeSchema((v, path, errors) => {
        const inner = check(v, path, errors);
        if (errors.length) return inner;
        if (!fn(inner)) errors.push({ path, message: msg });
        return inner;
      });
    },
  };
  return s;
}

function string() {
  let s = makeSchema((v, path, errors) => {
    if (typeof v !== 'string') errors.push({ path, message: `expected string, got ${typeof v}` });
    return v;
  });
  s.min = (n, msg) => s.refine((v) => v.length >= n, msg || `min length ${n}`);
  s.max = (n, msg) => s.refine((v) => v.length <= n, msg || `max length ${n}`);
  s.regex = (re, msg) => s.refine((v) => re.test(v), msg || `regex ${re}`);
  return s;
}

function number() {
  let s = makeSchema((v, path, errors) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push({ path, message: 'expected finite number' });
    return v;
  });
  s.int = (msg) => s.refine((v) => Number.isInteger(v), msg || 'expected integer');
  s.min = (n, msg) => s.refine((v) => v >= n, msg || `min ${n}`);
  s.max = (n, msg) => s.refine((v) => v <= n, msg || `max ${n}`);
  return s;
}

function boolean() {
  return makeSchema((v, path, errors) => {
    if (typeof v !== 'boolean') errors.push({ path, message: `expected boolean, got ${typeof v}` });
    return v;
  });
}

function literal(expected) {
  return makeSchema((v, path, errors) => {
    if (v !== expected) errors.push({ path, message: `expected literal ${JSON.stringify(expected)}, got ${JSON.stringify(v)}` });
    return v;
  });
}

function array(item) {
  if (!item || typeof item.safeParse !== 'function') throw new TypeError('array: item schema required');
  let s = makeSchema((v, path, errors) => {
    if (!Array.isArray(v)) { errors.push({ path, message: 'expected array' }); return v; }
    const out = [];
    for (let i = 0; i < v.length; i++) {
      const r = item.safeParse(v[i]);
      if (r.ok) out.push(r.value);
      else for (const e of r.errors) errors.push({ path: `${path}[${i}]${e.path === '$' ? '' : e.path.slice(1)}`, message: e.message });
    }
    return out;
  });
  s.min = (n, msg) => s.refine((v) => v.length >= n, msg || `min items ${n}`);
  s.max = (n, msg) => s.refine((v) => v.length <= n, msg || `max items ${n}`);
  return s;
}

function object(shape) {
  if (!shape || typeof shape !== 'object') throw new TypeError('object: shape required');
  let strictMode = false;
  const s = makeSchema((v, path, errors) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      errors.push({ path, message: 'expected object' });
      return v;
    }
    const out = {};
    for (const [key, sub] of Object.entries(shape)) {
      const childPath = path === '$' ? `$.${key}` : `${path}.${key}`;
      const has = Object.prototype.hasOwnProperty.call(v, key);
      if (!has) {
        // Skip absent key only if schema allows (caller used s.optional).
        const probe = sub.safeParse(undefined);
        if (probe.ok) { out[key] = probe.value; continue; }
        for (const e of probe.errors) errors.push({ path: childPath, message: e.message });
        continue;
      }
      const r = sub.safeParse(v[key]);
      if (r.ok) out[key] = r.value;
      else for (const e of r.errors) errors.push({ path: e.path === '$' ? childPath : childPath + e.path.slice(1), message: e.message });
    }
    if (strictMode) {
      for (const k of Object.keys(v)) {
        if (!Object.prototype.hasOwnProperty.call(shape, k)) {
          errors.push({ path: path === '$' ? `$.${k}` : `${path}.${k}`, message: 'unknown key (strict)' });
        }
      }
    }
    return out;
  });
  s.strict = () => { strictMode = true; return s; };
  return s;
}

function union(...schemas) {
  if (schemas.length === 0) throw new TypeError('union: at least one schema required');
  return makeSchema((v, path, errors) => {
    const collected = [];
    for (const sch of schemas) {
      const r = sch.safeParse(v);
      if (r.ok) return r.value;
      collected.push(r.errors);
    }
    errors.push({ path, message: `no union branch matched (tried ${schemas.length})` });
    return v;
  });
}

function optional(inner) {
  return makeSchema((v, path, errors) => {
    if (v === undefined) return undefined;
    const r = inner.safeParse(v);
    if (r.ok) return r.value;
    for (const e of r.errors) errors.push({ path: e.path === '$' ? path : path + e.path.slice(1), message: e.message });
    return v;
  });
}

function nullable(inner) {
  return makeSchema((v, path, errors) => {
    if (v === null) return null;
    const r = inner.safeParse(v);
    if (r.ok) return r.value;
    for (const e of r.errors) errors.push({ path: e.path === '$' ? path : path + e.path.slice(1), message: e.message });
    return v;
  });
}

module.exports = {
  string,
  number,
  boolean,
  literal,
  array,
  object,
  union,
  optional,
  nullable,
  SchemaError,
};
