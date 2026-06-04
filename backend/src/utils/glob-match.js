'use strict';

/**
 * glob-match — gitignore/fnmatch-style pattern matcher. Pairs with
 * the trie (#53), RBAC scope matcher (#68), and the include/exclude
 * lists used by upload security policy and tool authorization. The
 * RBAC matcher uses colon segments; this one uses path segments
 * (slashes). Both use ** for "one or more trailing segments".
 *
 * Pattern grammar:
 *   *           ANY chars except '/'
 *   **          ANY chars including '/' (matches one or more segments
 *               when between slashes; matches zero or more anywhere)
 *   ?           exactly ONE char except '/'
 *   [set]       single char from set; supports ranges (a-z) and
 *               negation [!abc]
 *   \x          escape the literal next char
 *
 * Public API:
 *   match(pattern, path)              → boolean
 *   compile(pattern)                  → fn(path) → boolean
 *   anyMatch(patterns, path)          → boolean
 *   filterMatches(patterns, paths)    → string[]
 */

function escapeRegex(s) {
  return s.replace(/[.+^$|()*?[\]{}\\]/g, '\\$&');
}

function compileToRegex(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      re += escapeRegex(pattern[i + 1]);
      i += 2; continue;
    }
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** — match across slashes
        re += '.*';
        i += 2;
        // Eat an immediately-following '/' so '**/x' matches both 'x' and 'a/x'.
        if (pattern[i] === '/') { re += '/?'; i += 1; }
        continue;
      }
      re += '[^/]*';
      i += 1; continue;
    }
    if (ch === '?') { re += '[^/]'; i += 1; continue; }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) { re += '\\['; i += 1; continue; }
      let body = pattern.slice(i + 1, close);
      // Negation: [!…] → [^…]
      if (body[0] === '!') body = '^' + body.slice(1);
      re += `[${body}]`;
      i = close + 1; continue;
    }
    re += escapeRegex(ch);
    i += 1;
  }
  // A malformed character class (reversed range like [z-a], or a class
  // ending in a backslash) makes `new RegExp` throw a SyntaxError. The rest
  // of this compiler is deliberately lenient toward malformed patterns
  // (an unterminated '[' is treated as a literal), so degrade a bad class to
  // a never-matching regex instead of throwing and poisoning the whole call.
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return /(?!x)x/;
  }
}

const compileCache = new Map();

function compile(pattern) {
  if (typeof pattern !== 'string') throw new TypeError('glob-match: pattern string required');
  let re = compileCache.get(pattern);
  if (!re) {
    re = compileToRegex(pattern);
    if (compileCache.size < 1024) compileCache.set(pattern, re);
  }
  return (path) => typeof path === 'string' && re.test(path);
}

function match(pattern, path) {
  return compile(pattern)(path);
}

function anyMatch(patterns, path) {
  if (!Array.isArray(patterns)) return false;
  for (const p of patterns) if (match(p, path)) return true;
  return false;
}

function filterMatches(patterns, paths) {
  if (!Array.isArray(paths)) return [];
  const fns = (Array.isArray(patterns) ? patterns : []).filter((p) => typeof p === 'string').map(compile);
  return paths.filter((p) => fns.some((fn) => fn(p)));
}

module.exports = {
  match,
  compile,
  anyMatch,
  filterMatches,
  _resetCache: () => compileCache.clear(),
};
