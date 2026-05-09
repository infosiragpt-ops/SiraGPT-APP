'use strict';

/**
 * deep-merge — recursive merge of plain objects without mutating
 * inputs. Pairs with deepClone (#64) for the snapshot, deepEqual
 * (#63) for after-the-fact comparison, and the typed env-loader
 * (#58, defaults + overrides). Most config-flavored callers want
 * this exact shape: a base of defaults, layered overrides on top,
 * arrays handled per a chosen strategy.
 *
 * Strategies for arrays:
 *   'replace' (default) — later array wins entirely
 *   'concat'            — element-wise concat
 *   'unique'            — concat then drop duplicates (preserves order)
 *   fn(a, b)            — caller-supplied merger
 *
 * Plain objects always merge recursively. Class-instance objects on
 * either side are treated as opaque values: the later one wins
 * verbatim (we do not invent prototype semantics for foreign types).
 *
 * Public API:
 *   deepMerge(...sources)
 *   deepMerge(...sources, { arrayMerge })
 *     last argument may be an options object IF it has only an
 *     `arrayMerge` key (so callers don't need a separate variant).
 *   isMergeOptions(o)        — exported for inspection
 */

const { isPlainObject } = require('./deep-equal');

const ARRAY_STRATEGIES = ['replace', 'concat', 'unique'];

function isMergeOptions(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const keys = Object.keys(o);
  if (keys.length === 0 || keys.length > 1) return false;
  return keys[0] === 'arrayMerge';
}

function mergeArrays(a, b, strategy) {
  if (typeof strategy === 'function') return strategy(a.slice(), b.slice());
  switch (strategy) {
    case 'concat': return [...a, ...b];
    case 'unique': {
      const seen = new Set();
      const out = [];
      for (const v of [...a, ...b]) {
        const key = typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
      }
      return out;
    }
    case 'replace':
    default:
      return b.slice();
  }
}

function mergeTwo(a, b, strategy) {
  if (Array.isArray(a) && Array.isArray(b)) return mergeArrays(a, b, strategy);
  if (isPlainObject(a) && isPlainObject(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined) continue;
      if (Object.prototype.hasOwnProperty.call(out, k)) {
        out[k] = mergeTwo(out[k], v, strategy);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  // Type mismatch or non-object value → b wins.
  return b;
}

function deepMerge(...args) {
  let strategy = 'replace';
  if (args.length > 1 && isMergeOptions(args[args.length - 1])) {
    const opts = args.pop();
    strategy = opts.arrayMerge;
    if (typeof strategy !== 'function' && !ARRAY_STRATEGIES.includes(strategy)) {
      throw new TypeError(`deep-merge: unknown arrayMerge "${strategy}"`);
    }
  }
  if (args.length === 0) return undefined;
  if (args.length === 1) return args[0];
  let acc = args[0];
  for (let i = 1; i < args.length; i++) acc = mergeTwo(acc, args[i], strategy);
  return acc;
}

module.exports = {
  deepMerge,
  isMergeOptions,
  ARRAY_STRATEGIES,
};
