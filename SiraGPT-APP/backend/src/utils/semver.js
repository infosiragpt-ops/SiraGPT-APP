'use strict';

/**
 * semver — minimal semver parser + comparator + range satisfier.
 * Pairs with the prompt-template registry (#16, version-tagged
 * lineage) and the cron parser (#54): when an internal subsystem
 * publishes a versioned interface, this is the right comparator.
 *
 * Subset:
 *   - Triplet major.minor.patch (each non-negative integer)
 *   - Optional prerelease tag '-foo.1' (compared per spec: numeric
 *     identifiers numerically, alpha lexically, prerelease < release)
 *   - Build metadata '+sha' is parsed but ignored for comparison
 *
 * Range syntax:
 *   '1.2.3'        exact
 *   '=1.2.3'       same as exact
 *   '>1.2.3' / '>=' / '<' / '<='  obvious
 *   '^1.2.3'       compatible with leftmost non-zero (caret)
 *   '~1.2.3'       reasonably close (allow patch bumps)
 *   'a || b'       union of ranges
 *   'a b'          intersection (space = AND, classic semver)
 *
 * Public API:
 *   parse(version)             → { major, minor, patch, prerelease, build } | null
 *   compare(a, b)              → -1 / 0 / 1
 *   satisfies(version, range)  → boolean
 *   maxSatisfying(versions, range) → string | null
 */

const STRICT = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z\-.]+))?(?:\+([0-9A-Za-z\-.]+))?$/;

function parse(version) {
  if (typeof version !== 'string' || !version) return null;
  const m = STRICT.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    build: m[5] || null,
  };
}

function comparePrerelease(a, b) {
  // Per spec: a non-prerelease beats a prerelease; otherwise compare
  // identifier-by-identifier.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      const dx = Number(x), dy = Number(y);
      if (dx !== dy) return dx < dy ? -1 : 1;
    } else if (xn) return -1;
    else if (yn) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

function compare(a, b) {
  const pa = typeof a === 'string' ? parse(a) : a;
  const pb = typeof b === 'string' ? parse(b) : b;
  if (!pa || !pb) throw new TypeError('semver.compare: bad version');
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function intersectAtom(version, atom) {
  const v = parse(version);
  if (!v) return false;
  const trimmed = atom.trim();
  // Handle ^ and ~ first (consume operator + read base).
  if (trimmed.startsWith('^')) {
    const base = parse(trimmed.slice(1));
    if (!base) return false;
    if (compare(v, base) < 0) return false;
    // ^ keeps leftmost non-zero stable
    if (base.major > 0) return v.major === base.major;
    if (base.minor > 0) return v.major === 0 && v.minor === base.minor;
    return v.major === 0 && v.minor === 0 && v.patch === base.patch;
  }
  if (trimmed.startsWith('~')) {
    const base = parse(trimmed.slice(1));
    if (!base) return false;
    if (compare(v, base) < 0) return false;
    return v.major === base.major && v.minor === base.minor;
  }
  // Comparator operators
  let op = '=';
  let rest = trimmed;
  for (const o of ['>=', '<=', '=', '>', '<']) {
    if (rest.startsWith(o)) { op = o; rest = rest.slice(o.length).trim(); break; }
  }
  const base = parse(rest);
  if (!base) return false;
  const c = compare(v, base);
  switch (op) {
    case '=':  return c === 0;
    case '>':  return c > 0;
    case '>=': return c >= 0;
    case '<':  return c < 0;
    case '<=': return c <= 0;
    default:   return false;
  }
}

function satisfies(version, range) {
  if (typeof range !== 'string' || !range.trim()) return false;
  // Union via '||'
  const branches = range.split('||').map((b) => b.trim()).filter(Boolean);
  for (const branch of branches) {
    // Intersection via whitespace
    const atoms = branch.split(/\s+/).filter(Boolean);
    if (atoms.length === 0) continue;
    if (atoms.every((a) => intersectAtom(version, a))) return true;
  }
  return false;
}

function maxSatisfying(versions, range) {
  if (!Array.isArray(versions)) return null;
  let best = null;
  for (const v of versions) {
    if (!satisfies(v, range)) continue;
    if (!best || compare(v, best) > 0) best = v;
  }
  return best;
}

module.exports = {
  parse,
  compare,
  satisfies,
  maxSatisfying,
};
