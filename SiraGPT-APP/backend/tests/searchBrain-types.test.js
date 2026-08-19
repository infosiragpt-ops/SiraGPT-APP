/**
 * Tests for services/searchBrain/types.js — constants module pin.
 *
 * Pure constants, but pinning them ensures an accidental rename
 * or removal surfaces as a test failure (these names are imported by
 * the public entrypoint and would silently break callers).
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  DEFAULT_ACADEMIC_SOURCES,
  DEFAULT_WEIGHTS,
  USER_AGENT,
} = require('../src/services/searchBrain/types');

describe('DEFAULT_ACADEMIC_SOURCES', () => {
  it('contains the exact documented 8-provider list', () => {
    assert.deepEqual(DEFAULT_ACADEMIC_SOURCES, [
      'wos',
      'scopus',
      'openalex',
      'scielo',
      'semantic',
      'crossref',
      'pubmed',
      'doaj',
    ]);
  });

  it('has exactly 8 entries (catches accidental additions)', () => {
    assert.equal(DEFAULT_ACADEMIC_SOURCES.length, 8);
  });

  it('contains no duplicates', () => {
    const seen = new Set(DEFAULT_ACADEMIC_SOURCES);
    assert.equal(seen.size, DEFAULT_ACADEMIC_SOURCES.length);
  });

  it('every entry is a lowercase non-empty string', () => {
    for (const src of DEFAULT_ACADEMIC_SOURCES) {
      assert.equal(typeof src, 'string');
      assert.ok(src.length > 0);
      assert.equal(src, src.toLowerCase());
    }
  });
});

describe('DEFAULT_WEIGHTS', () => {
  it('pins the exact weight values', () => {
    assert.deepEqual({ ...DEFAULT_WEIGHTS }, {
      rerank: 1.0,
      providerRank: 0.3,
      citations: 0.2,
      openAccessBoost: 0.1,
    });
  });

  it('is frozen (cannot be mutated at runtime)', () => {
    assert.throws(() => { DEFAULT_WEIGHTS.rerank = 999; }, TypeError);
  });

  it('contains exactly the documented weight names', () => {
    const keys = Object.keys(DEFAULT_WEIGHTS).sort();
    assert.deepEqual(keys, [
      'citations',
      'openAccessBoost',
      'providerRank',
      'rerank',
    ]);
  });

  it('rerank has the largest weight (dominant signal)', () => {
    // Pin the invariant: rerank is the primary ranking signal so its
    // weight must dominate citations + providerRank + openAccessBoost.
    const others = ['providerRank', 'citations', 'openAccessBoost'];
    for (const k of others) {
      assert.ok(
        DEFAULT_WEIGHTS.rerank > DEFAULT_WEIGHTS[k],
        `expected rerank weight (${DEFAULT_WEIGHTS.rerank}) > ${k} (${DEFAULT_WEIGHTS[k]})`,
      );
    }
  });

  it('every weight is a positive finite number', () => {
    for (const [k, v] of Object.entries(DEFAULT_WEIGHTS)) {
      assert.equal(typeof v, 'number', `${k} must be number`);
      assert.ok(Number.isFinite(v), `${k} must be finite`);
      assert.ok(v > 0, `${k} must be > 0 (was ${v})`);
    }
  });
});

describe('USER_AGENT', () => {
  it('is a non-empty string with project name + responsibility note', () => {
    assert.equal(typeof USER_AGENT, 'string');
    assert.ok(USER_AGENT.length > 0);
    assert.match(USER_AGENT, /siraGPT-SearchBrain/);
    // Convention: include a contact URL so site owners can identify us.
    assert.match(USER_AGENT, /https:\/\//);
    // "responsible" language is part of the contract with academic sites
    // that have anti-scraping policies — keep it pinned.
    assert.match(USER_AGENT, /responsible/i);
  });
});

describe('module surface', () => {
  it('exports exactly { DEFAULT_ACADEMIC_SOURCES, DEFAULT_WEIGHTS, USER_AGENT }', () => {
    const types = require('../src/services/searchBrain/types');
    const keys = Object.keys(types).sort();
    assert.deepEqual(keys, [
      'DEFAULT_ACADEMIC_SOURCES',
      'DEFAULT_WEIGHTS',
      'USER_AGENT',
    ]);
  });
});
