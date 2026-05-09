'use strict';

/**
 * scope-matcher — Stripe-style colon-separated scope matcher with
 * wildcards. Pairs with the tool-authorization gate (#4) which
 * already accepts a held-scopes set; this module is the rule
 * evaluator the gate calls into when scopes need pattern matching
 * rather than exact-equality.
 *
 * Scope grammar:
 *   - 'a:b:c'   exact 3-segment scope (colon-separated)
 *   - '*'       wildcard for ONE segment
 *   - '**'      wildcard for ONE OR MORE trailing segments (must be last)
 *
 * Examples:
 *   'read:users:42'   matches  'read:users:*'   ✓
 *   'read:users:42'   matches  'read:**'        ✓
 *   'read:users:42'   matches  '*:users:*'      ✓
 *   'write:users:42'  matches  'read:**'        ✗
 *
 * Public API:
 *   matchScope(pattern, scope)              → boolean
 *   anyMatch(patterns, scope)               → boolean
 *   filterAllowed(patterns, scopes)         → string[] (subset of scopes
 *                                              matched by any pattern)
 *   compilePatterns(patterns)               → fast matcher fn
 *   isValidPattern(pattern) / isValidScope(scope)
 */

const SEG_RE = /^[A-Za-z0-9_.-]+$/;

function splitSegments(s) {
  return String(s).split(':');
}

function isValidScope(scope) {
  if (typeof scope !== 'string' || !scope) return false;
  return splitSegments(scope).every((s) => s !== '' && SEG_RE.test(s));
}

function isValidPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) return false;
  const parts = splitSegments(pattern);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '*') continue;
    if (p === '**') {
      // ** must be the LAST segment
      return i === parts.length - 1;
    }
    if (!SEG_RE.test(p)) return false;
  }
  return true;
}

function matchScope(pattern, scope) {
  if (!isValidPattern(pattern) || !isValidScope(scope)) return false;
  const pp = splitSegments(pattern);
  const ss = splitSegments(scope);
  for (let i = 0; i < pp.length; i++) {
    const p = pp[i];
    // ** requires at least one trailing segment (one OR more) per docs.
    if (p === '**') return i === pp.length - 1 && ss.length > i;
    if (i >= ss.length) return false;
    if (p === '*') continue;
    if (p !== ss[i]) return false;
  }
  return ss.length === pp.length;
}

function anyMatch(patterns, scope) {
  if (!Array.isArray(patterns)) return false;
  for (const p of patterns) if (matchScope(p, scope)) return true;
  return false;
}

function filterAllowed(patterns, scopes) {
  if (!Array.isArray(scopes)) return [];
  return scopes.filter((s) => anyMatch(patterns, s));
}

function compilePatterns(patterns) {
  if (!Array.isArray(patterns)) throw new TypeError('compilePatterns: array required');
  const valid = patterns.filter((p) => isValidPattern(p));
  return (scope) => {
    for (const p of valid) if (matchScope(p, scope)) return true;
    return false;
  };
}

module.exports = {
  matchScope,
  anyMatch,
  filterAllowed,
  compilePatterns,
  isValidPattern,
  isValidScope,
  splitSegments,
};
