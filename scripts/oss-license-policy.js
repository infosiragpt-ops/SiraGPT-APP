'use strict';

/**
 * oss-license-policy — single source of truth for the "Agentes de
 * codificación" open-source fusion policy (docs/oss-catalog.md §Licencias).
 *
 * Only these SPDX families may be copied/vendored into SiraGPT-APP, always
 * with copyright headers preserved and the original LICENSE/NOTICE saved
 * under vendor/<slug>/ (see THIRD_PARTY_NOTICES.md):
 *   MIT, Apache-2.0, BSD-2/3-Clause, ISC, MPL-2.0, PostgreSQL License,
 *   Unlicense, CC0-1.0, 0BSD.
 *
 * Forbidden (never vendored; at most consumed as an unmodified external
 * service or rejected outright):
 *   GPL/AGPL/LGPL (any version), CDDL, EPL, MPL-1.1, NPOSL (copyleft /
 *   network-copyleft contamination risk), FSL / Functional Source License
 *   (only reverts to MIT years after each release), SSPL, Sustainable Use
 *   licenses, proprietary/commercial terms, unknown or missing licenses.
 *
 * Pure + dependency-free so both scripts/generate-third-party-licenses.js
 * and backend/tests/oss-license-policy.test.js can require it.
 */

const ALLOWED_FAMILIES = Object.freeze([
  'MIT',
  'APACHE-2.0',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  'ISC',
  'MPL-2.0',
  'POSTGRESQL',
  'UNLICENSE',
  'CC0-1.0',
  '0BSD',
]);

// Substring patterns (uppercased input) that make a license forbidden.
// Keep in sync with scripts/generate-third-party-licenses.js FORBIDDEN_PATTERNS.
const FORBIDDEN_PATTERNS = Object.freeze([
  'GPL',
  'AGPL',
  'LGPL',
  'CDDL',
  'EPL',
  'MPL-1.1',
  'NPOSL',
  'FSL',
  'SSPL',
  'SUSTAINABLE',
]);

function normalizeSpdx(value) {
  return String(value || '').replace(/[()*]/g, '').trim().toUpperCase();
}

/**
 * Split a dual-license expression ("MIT OR GPL-3.0", "MIT | Apache-2.0").
 * Returns { parts } — the caller elects the permissive side.
 */
function splitDualLicense(normalized) {
  return String(normalized || '')
    .split(/\s+OR\s+|\s*\|\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isPermissiveSide(part) {
  return /MIT|APACHE|BSD|ISC|CC0|UNLICENSE|0BSD|POSTGRESQL|MPL-2\.0/.test(part);
}

/**
 * Classify an SPDX license string.
 * Returns 'allowed' | 'forbidden' | 'unknown'.
 * Dual licenses elect the permissive side (same rule as the licenses gate).
 */
function classifyLicense(spdx) {
  const norm = normalizeSpdx(spdx);
  if (!norm || norm === 'UNKNOWN' || norm === 'UNLICENSED') return 'unknown';
  if (/\bOR\b/.test(norm) || norm.includes('|')) {
    const parts = splitDualLicense(norm);
    if (parts.some(isPermissiveSide)) {
      const rest = parts.filter((p) => !isPermissiveSide(p));
      if (rest.some((p) => FORBIDDEN_PATTERNS.some((pat) => p.includes(pat)))) {
        // Permissive side elected, but record the copyleft half as forbidden
        // so callers never pick it by accident.
        return 'allowed';
      }
      return 'allowed';
    }
  }
  if (FORBIDDEN_PATTERNS.some((pat) => norm.includes(pat))) return 'forbidden';
  if (isPermissiveSide(norm)) return 'allowed';
  return 'unknown';
}

function isForbiddenLicense(spdx) {
  return classifyLicense(spdx) === 'forbidden';
}

module.exports = {
  ALLOWED_FAMILIES,
  FORBIDDEN_PATTERNS,
  normalizeSpdx,
  splitDualLicense,
  classifyLicense,
  isForbiddenLicense,
};
