'use strict';

/**
 * deep-equal — structural equality for arbitrary JS values, with
 * proper handling of NaN, Date, RegExp, Map, Set, Buffer, typed
 * arrays, and circular references. Pairs with canonical-json (#50,
 * for hashing-style equality) and the LRU cache (#46, for value
 * dedup) — when you need an actual equality test rather than a
 * hash collision.
 *
 * Public API:
 *   deepEqual(a, b)           → boolean
 *   deepDiff(a, b)            → [{ path, a, b }] (empty if equal)
 */

const ARRAY_BUFFER_VIEWS = new Set([
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array',
]);

function isPrimitiveEqual(a, b) {
  // Object.is to handle NaN === NaN and -0 ≠ 0 distinction.
  return Object.is(a, b);
}

function isPlainObject(o) {
  if (o === null || typeof o !== 'object') return false;
  const proto = Object.getPrototypeOf(o);
  return proto === Object.prototype || proto === null;
}

function compare(a, b, seen, diffs, path) {
  if (isPrimitiveEqual(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    if (diffs) diffs.push({ path, a, b });
    return false;
  }

  // Cycle guard: if we already saw this pair, treat as equal (would
  // otherwise infinite-loop).
  const memoKey = a;
  const peerSet = seen.get(memoKey);
  if (peerSet && peerSet.has(b)) return true;
  if (peerSet) peerSet.add(b);
  else seen.set(memoKey, new Set([b]));

  // Date
  if (a instanceof Date || b instanceof Date) {
    const eq = a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    if (!eq && diffs) diffs.push({ path, a, b });
    return eq;
  }
  // RegExp
  if (a instanceof RegExp || b instanceof RegExp) {
    const eq = a instanceof RegExp && b instanceof RegExp
      && a.source === b.source && a.flags === b.flags;
    if (!eq && diffs) diffs.push({ path, a, b });
    return eq;
  }
  // Map
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) { if (diffs) diffs.push({ path, a, b }); return false; }
    for (const [k, va] of a) {
      if (!b.has(k)) { if (diffs) diffs.push({ path: `${path}.<map>${String(k)}`, a: va, b: undefined }); return false; }
      if (!compare(va, b.get(k), seen, diffs, `${path}.<map>${String(k)}`)) return false;
    }
    return true;
  }
  // Set (compare via primitive membership only — deep equality on Set
  // would require pairing, which is exponential in worst case).
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) { if (diffs) diffs.push({ path, a, b }); return false; }
    for (const v of a) if (!b.has(v)) { if (diffs) diffs.push({ path: `${path}.<set>`, a, b }); return false; }
    return true;
  }
  // Buffer / typed arrays
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) {
    const eq = a.equals(b);
    if (!eq && diffs) diffs.push({ path, a, b });
    return eq;
  }
  const aTag = a[Symbol.toStringTag] || a.constructor?.name;
  const bTag = b[Symbol.toStringTag] || b.constructor?.name;
  if (aTag === bTag && ARRAY_BUFFER_VIEWS.has(aTag)) {
    if (a.length !== b.length) { if (diffs) diffs.push({ path, a, b }); return false; }
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) {
      if (diffs) diffs.push({ path: `${path}[${i}]`, a: a[i], b: b[i] });
      return false;
    }
    return true;
  }
  // Array
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      if (diffs) diffs.push({ path, a, b });
      return false;
    }
    let allEq = true;
    for (let i = 0; i < a.length; i++) {
      if (!compare(a[i], b[i], seen, diffs, `${path}[${i}]`)) {
        if (!diffs) return false;
        allEq = false;
      }
    }
    return allEq;
  }
  // Plain object (or class instance with same constructor — we
  // compare own enumerable string keys).
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) {
    if (diffs) diffs.push({ path, a, b });
    return false;
  }
  let allEq = true;
  for (const k of aKeys) {
    if (!compare(a[k], b[k], seen, diffs, path === '$' ? `$.${k}` : `${path}.${k}`)) {
      if (!diffs) return false;
      allEq = false;
    }
  }
  return allEq;
}

function deepEqual(a, b) {
  return compare(a, b, new Map(), null, '$');
}

function deepDiff(a, b) {
  const diffs = [];
  compare(a, b, new Map(), diffs, '$');
  return diffs;
}

module.exports = {
  deepEqual,
  deepDiff,
  isPlainObject,
};
