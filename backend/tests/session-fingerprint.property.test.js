/**
 * Property tests for utils/session-fingerprint.js.
 *
 * Invariants:
 *   1. Determinism — same (ip, ua) always produces the same digest
 *      across many invocations.
 *   2. Discrimination — different inputs produce different digests
 *      with very high probability (collisions on sha256 over the
 *      tiny input space we generate are astronomically unlikely).
 *   3. IP /24 grouping — two IPv4s sharing their first three octets
 *      collapse to the same fingerprint when UA is held constant.
 *
 * The pepper is fixed via env so the test is hermetic.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

before(() => {
  process.env.SESSION_FINGERPRINT_PEPPER = 'property-test-pepper';
});

const {
  computeFingerprint,
  compareFingerprints,
} = require('../src/utils/session-fingerprint');

const ipv4 = fc
  .tuple(
    fc.integer({ min: 1, max: 223 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 1, max: 254 }),
  )
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

const uaString = fc.stringMatching(/^[A-Za-z0-9 ./()_-]{4,80}$/);

test('computeFingerprint is deterministic', () => {
  fc.assert(
    fc.property(ipv4, uaString, (ip, ua) => {
      const a = computeFingerprint({ ip, ua });
      const b = computeFingerprint({ ip, ua });
      return a === b && compareFingerprints(a, b);
    }),
    { numRuns: 150 },
  );
});

test('different (ip, ua) pairs produce different fingerprints', () => {
  fc.assert(
    fc.property(ipv4, ipv4, uaString, uaString, (ip1, ip2, ua1, ua2) => {
      // Skip when both pairs reduce to the same input — the /24
      // collapse is exercised in its own test below.
      const class1 = ip1.split('.').slice(0, 3).join('.');
      const class2 = ip2.split('.').slice(0, 3).join('.');
      if (class1 === class2 && ua1.toLowerCase().trim() === ua2.toLowerCase().trim()) {
        return true;
      }
      const a = computeFingerprint({ ip: ip1, ua: ua1 });
      const b = computeFingerprint({ ip: ip2, ua: ua2 });
      return a !== b;
    }),
    { numRuns: 200 },
  );
});

test('IPs sharing /24 collapse to the same fingerprint (UA fixed)', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 223 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 1, max: 254 }),
      fc.integer({ min: 1, max: 254 }),
      uaString,
      (a, b, c, d1, d2, ua) => {
        const ip1 = `${a}.${b}.${c}.${d1}`;
        const ip2 = `${a}.${b}.${c}.${d2}`;
        const f1 = computeFingerprint({ ip: ip1, ua });
        const f2 = computeFingerprint({ ip: ip2, ua });
        return f1 === f2;
      },
    ),
    { numRuns: 100 },
  );
});

test('compareFingerprints returns false on length mismatch and empty inputs', () => {
  assert.equal(compareFingerprints('', 'abc'), false);
  assert.equal(compareFingerprints('abc', ''), false);
  assert.equal(compareFingerprints(null, 'abc'), false);
});
