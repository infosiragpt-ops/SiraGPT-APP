'use strict';

/**
 * deep-clone — cycle-safe structural clone for arbitrary JS values.
 * Complement of deepEqual (#63). Handles plain objects, arrays, Map,
 * Set, Date, RegExp, Buffer, typed arrays. More portable than
 * `structuredClone` in mixed-runtime environments and lets us be
 * explicit about which constructors we round-trip.
 *
 * Functions, symbols, class instances with non-trivial prototypes,
 * WeakMap, WeakSet — left as-is in the output (shallow copy is the
 * least-bad option). Other than that, the output shares no
 * references with the input.
 *
 * Public API:
 *   deepClone(value)        → cloned value
 *   deepCloneMany(...vals)  → cloned tuple as array
 */

function isTypedArray(v) {
  return ArrayBuffer.isView(v) && !Buffer.isBuffer(v) && !(v instanceof DataView);
}

function clone(value, seen) {
  if (value === null) return null;
  const t = typeof value;
  if (t !== 'object' && t !== 'function') return value;
  if (t === 'function' || typeof value === 'symbol') return value;

  // Cycle handling
  if (seen.has(value)) return seen.get(value);

  // Date
  if (value instanceof Date) {
    const out = new Date(value.getTime());
    seen.set(value, out);
    return out;
  }
  // RegExp
  if (value instanceof RegExp) {
    const out = new RegExp(value.source, value.flags);
    out.lastIndex = value.lastIndex;
    seen.set(value, out);
    return out;
  }
  // Buffer
  if (Buffer.isBuffer(value)) {
    const out = Buffer.from(value);
    seen.set(value, out);
    return out;
  }
  // Typed arrays
  if (isTypedArray(value)) {
    const out = new value.constructor(value);
    seen.set(value, out);
    return out;
  }
  // Map
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [k, v] of value) out.set(clone(k, seen), clone(v, seen));
    return out;
  }
  // Set
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const v of value) out.add(clone(v, seen));
    return out;
  }
  // Array
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) out[i] = clone(value[i], seen);
    return out;
  }
  // Plain object — preserve prototype-null specifically; other class
  // instances copy own enumerable string keys onto a same-prototype
  // shell. Symbols/non-enumerable keys are intentionally not cloned.
  const proto = Object.getPrototypeOf(value);
  const out = proto === null ? Object.create(null) : (proto === Object.prototype ? {} : Object.create(proto));
  seen.set(value, out);
  for (const k of Object.keys(value)) out[k] = clone(value[k], seen);
  return out;
}

function deepClone(value) {
  return clone(value, new Map());
}

function deepCloneMany(...values) {
  const seen = new Map();
  return values.map((v) => clone(v, seen));
}

module.exports = {
  deepClone,
  deepCloneMany,
};
