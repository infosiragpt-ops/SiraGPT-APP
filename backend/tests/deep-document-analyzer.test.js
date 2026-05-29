'use strict';

// Tests for deep-document-analyzer.detectDomain after the keyword regexes
// were pre-compiled once at module load (instead of rebuilt per call). The
// idempotency test is the safety net for that change: shared global regexes
// must not leak match state across calls.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { detectDomain } = require('../src/services/deep-document-analyzer');

describe('deep-document-analyzer detectDomain', () => {
  test('detects the legal domain from legal terminology', () => {
    const d = detectDomain(
      'This contract and agreement set out each clause under the governing law and jurisdiction.',
      '', '',
    );
    assert.equal(d.primary, 'legal');
    assert.ok(d.confidence > 0);
  });

  test('detects the technical domain', () => {
    const d = detectDomain(
      'The API server connects to a database, shipped with docker and kubernetes.',
      '', '',
    );
    assert.equal(d.primary, 'technical');
  });

  test('detects the financial domain', () => {
    const d = detectDomain(
      'revenue and budget and ebitda and expense and asset and equity',
      '', '',
    );
    assert.equal(d.primary, 'financial');
  });

  test('falls back to general when no domain keywords are present', () => {
    const d = detectDomain('the quick brown fox jumped over', '', '');
    assert.equal(d.primary, 'general');
  });

  test('is idempotent across repeated calls (shared regexes keep no state)', () => {
    const text = 'revenue and budget and ebitda and expense and asset and equity';
    const a = detectDomain(text, '', '');
    const b = detectDomain(text, '', '');
    const c = detectDomain(text, '', '');
    assert.deepEqual(a.scores, b.scores);
    assert.deepEqual(b.scores, c.scores);
    assert.equal(a.primary, b.primary);
  });
});
