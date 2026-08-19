'use strict';

/**
 * json-merge-patch — RFC 7396 implementation. Sibling to json-patch
 * (RFC 6902) but a different algorithm: merge patches are *plain
 * JSON documents* where every key tells the receiver to set, replace,
 * or delete a field, with `null` reserved as the delete sentinel.
 *
 *   apply({ a: 1, b: 2 }, { b: 9, c: 3 }) → { a: 1, b: 9, c: 3 }
 *   apply({ a: 1, b: 2 }, { b: null })    → { a: 1 }
 *
 * Use json-merge-patch when partial updates are nested objects and
 * the deletion semantics are obvious. Use json-patch when you need
 * to operate on arrays or express explicit ordered ops (move,
 * test, copy). Both have their place; this one is shorter and
 * friendlier for "PATCH /resource" endpoints.
 *
 * Public API:
 *   apply(target, patch)      — RFC 7396 §2: returns new value
 *   diff(source, target)      — RFC 7396 §3: minimal patch s → t
 *   isMergePatch(value)       — predicate
 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Never merge these keys — assigning them reparents/pollutes the prototype
// chain of the merged object. RFC 7396 is lenient, so we drop them silently.
const FORBIDDEN_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function apply(target, patch) {
  // RFC 7396 §2: if patch is not an object, the result is the patch.
  if (!isPlainObject(patch)) return patch;
  // If target is not an object, start from a fresh empty object.
  const out = isPlainObject(target) ? Object.assign({}, target) : {};
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) continue;
    const value = patch[key];
    if (value === null) {
      delete out[key];
    } else if (isPlainObject(value)) {
      out[key] = apply(out[key], value);
    } else {
      // Arrays and primitives are wholesale replaced (no in-place merge).
      out[key] = value;
    }
  }
  return out;
}

function diff(source, target) {
  // RFC 7396 §3: produces a minimal merge patch such that
  //   apply(source, diff(source, target)) deepEquals target
  if (!isPlainObject(source) || !isPlainObject(target)) {
    // If either side isn't an object, the patch is just the target.
    return clone(target);
  }
  const patch = {};
  // Properties present in target.
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      patch[key] = clone(target[key]);
      continue;
    }
    const sv = source[key];
    const tv = target[key];
    if (isPlainObject(sv) && isPlainObject(tv)) {
      const sub = diff(sv, tv);
      if (Object.keys(sub).length > 0) patch[key] = sub;
    } else if (!deepEqual(sv, tv)) {
      patch[key] = clone(tv);
    }
  }
  // Properties removed in target → null.
  for (const key of Object.keys(source)) {
    if (!(key in target)) patch[key] = null;
  }
  return patch;
}

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = clone(v[k]);
  return out;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a); const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

function isMergePatch(value) {
  // Per RFC 7396 the entire JSON document space is valid; this
  // predicate is a structural check for "this looks like a patch
  // someone meant to send" — i.e. an object (most common case)
  // or any non-undefined JSON value.
  return value !== undefined;
}

module.exports = {
  apply,
  diff,
  isMergePatch,
};
