'use strict';

/**
 * oss-license-policy — the OSS fusion gate for Agentes de codificación.
 * Only MIT/Apache-2.0/BSD/ISC/MPL-2.0/PostgreSQL (+Unlicense/CC0/0BSD) may be
 * vendored. Copyleft, network-copyleft, FSL, SSPL and Sustainable-Use are
 * forbidden. Mirrors scripts/generate-third-party-licenses.js behavior.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_FAMILIES,
  FORBIDDEN_PATTERNS,
  classifyLicense,
  isForbiddenLicense,
} = require('../../scripts/oss-license-policy');

test('allowed families cover the fusion policy (MIT/Apache/BSD/ISC/MPL-2.0/PostgreSQL)', () => {
  for (const family of ['MIT', 'APACHE-2.0', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'ISC', 'MPL-2.0', 'POSTGRESQL']) {
    assert.ok(ALLOWED_FAMILIES.includes(family), `missing allowed family ${family}`);
    assert.equal(classifyLicense(family), 'allowed');
  }
});

test('copyleft and network-copyleft are forbidden', () => {
  for (const lic of ['GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'CDDL-1.0', 'EPL-2.0', 'MPL-1.1', 'NPOSL-3.0']) {
    assert.equal(classifyLicense(lic), 'forbidden', lic);
    assert.equal(isForbiddenLicense(lic), true);
  }
});

test('FSL, SSPL and Sustainable-Use are forbidden (never revert in time)', () => {
  assert.equal(classifyLicense('FSL-1.1-MIT'), 'forbidden');
  assert.equal(classifyLicense('SSPL-1.0'), 'forbidden');
  assert.equal(classifyLicense('Sustainable-Use-License-1.0'), 'forbidden');
  assert.ok(FORBIDDEN_PATTERNS.includes('FSL'));
  assert.ok(FORBIDDEN_PATTERNS.includes('SSPL'));
});

test('the licenses gate shares the same forbidden list (single source of truth)', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'scripts', 'generate-third-party-licenses.js'),
    'utf8',
  );
  assert.match(src, /require\('\.\/oss-license-policy'\)/);
  assert.doesNotMatch(src, /const FORBIDDEN_PATTERNS = \[/, 'no duplicated forbidden list in the gate script');
});

test('dual licenses elect the permissive side', () => {
  assert.equal(classifyLicense('MIT OR GPL-3.0'), 'allowed');
  assert.equal(classifyLicense('Apache-2.0 OR MIT'), 'allowed');
});

test('unknown or missing licenses are never silently allowed', () => {
  assert.equal(classifyLicense(''), 'unknown');
  assert.equal(classifyLicense(null), 'unknown');
  assert.equal(classifyLicense('UNLICENSED'), 'unknown');
  assert.equal(classifyLicense('Commercial-Proprietary'), 'unknown');
  assert.equal(isForbiddenLicense('MIT'), false);
});
