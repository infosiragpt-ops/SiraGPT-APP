'use strict';

/**
 * case-convert — string-case helpers. Pairs with the env-loader
 * (#58, normalize key names), the qs serializer (#96, normalize
 * query keys), and any external integration (Stripe-style
 * snake_case ↔ React-style camelCase).
 *
 * All converters first tokenize the input into lowercase words by
 * splitting on transitions (camelHumps, separators, digit/letter
 * boundaries) so they round-trip cleanly across formats.
 *
 * Public API:
 *   toCamel('hello_world')   → 'helloWorld'
 *   toPascal('hello_world')  → 'HelloWorld'
 *   toSnake('helloWorld')    → 'hello_world'
 *   toKebab('helloWorld')    → 'hello-world'
 *   toTitle('hello_world')   → 'Hello World'
 *   words('helloWorld')      → ['hello', 'world']  (exposed)
 *   convertKeys(obj, fn)     — recursively rename object keys
 */

function words(str) {
  if (typeof str !== 'string' || !str) return [];
  return str
    // Split between lowercase/digit and uppercase: camelCase → camel|Case
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    // Split between consecutive uppercase and following uppercase+lowercase: ABCDef → ABC|Def
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // Replace separators with space
    .replace(/[_\-\s.]+/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
}

function toCamel(str) {
  const w = words(str);
  if (w.length === 0) return '';
  return w[0] + w.slice(1).map((s) => s[0].toUpperCase() + s.slice(1)).join('');
}

function toPascal(str) {
  return words(str).map((s) => s[0].toUpperCase() + s.slice(1)).join('');
}

function toSnake(str) {
  return words(str).join('_');
}

function toKebab(str) {
  return words(str).join('-');
}

function toTitle(str) {
  return words(str).map((s) => s[0].toUpperCase() + s.slice(1)).join(' ');
}

function convertKeys(value, fn) {
  if (typeof fn !== 'function') throw new TypeError('convertKeys: fn required');
  if (Array.isArray(value)) return value.map((v) => convertKeys(v, fn));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[fn(k)] = convertKeys(v, fn);
    return out;
  }
  return value;
}

module.exports = {
  words,
  toCamel,
  toPascal,
  toSnake,
  toKebab,
  toTitle,
  convertKeys,
};
