'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { build, parse, isPreloadEligible, SECONDS_IN_YEAR } = require('../src/utils/hsts');

describe('build', () => {
  test('max-age only', () => {
    assert.equal(build({ maxAge: 3600 }), 'max-age=3600');
  });
  test('with includeSubDomains', () => {
    assert.equal(build({ maxAge: 3600, includeSubDomains: true }), 'max-age=3600; includeSubDomains');
  });
  test('with preload (full preload-eligible config)', () => {
    const h = build({ maxAge: SECONDS_IN_YEAR, includeSubDomains: true, preload: true });
    assert.equal(h, `max-age=${SECONDS_IN_YEAR}; includeSubDomains; preload`);
  });
  test('preload without long max-age throws', () => {
    assert.throws(
      () => build({ maxAge: 3600, includeSubDomains: true, preload: true }),
      RangeError
    );
  });
  test('preload without includeSubDomains throws', () => {
    assert.throws(
      () => build({ maxAge: SECONDS_IN_YEAR, preload: true }),
      RangeError
    );
  });
  test('negative or non-numeric maxAge throws', () => {
    assert.throws(() => build({ maxAge: -1 }), TypeError);
    assert.throws(() => build({ maxAge: NaN }), TypeError);
    assert.throws(() => build({}), TypeError);
  });
  test('floors fractional maxAge', () => {
    assert.equal(build({ maxAge: 3600.9 }), 'max-age=3600');
  });
});

describe('parse', () => {
  test('basic max-age', () => {
    assert.deepEqual(parse('max-age=3600'), {
      maxAge: 3600,
      includeSubDomains: false,
      preload: false,
    });
  });
  test('all directives', () => {
    assert.deepEqual(parse('max-age=31536000; includeSubDomains; preload'), {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    });
  });
  test('case-insensitive directive names', () => {
    const r = parse('MAX-AGE=100; INCLUDESUBDOMAINS');
    assert.equal(r.maxAge, 100);
    assert.equal(r.includeSubDomains, true);
  });
  test('quoted max-age value', () => {
    assert.equal(parse('max-age="3600"').maxAge, 3600);
  });
  test('missing max-age → null', () => {
    assert.equal(parse('includeSubDomains; preload'), null);
  });
  test('empty / non-string → null', () => {
    assert.equal(parse(''), null);
    assert.equal(parse(null), null);
  });
});

describe('isPreloadEligible', () => {
  test('full preload config', () => {
    const p = parse(`max-age=${SECONDS_IN_YEAR}; includeSubDomains; preload`);
    assert.equal(isPreloadEligible(p), true);
  });
  test('short max-age fails', () => {
    const p = parse('max-age=86400; includeSubDomains; preload');
    assert.equal(isPreloadEligible(p), false);
  });
  test('missing includeSubDomains fails', () => {
    const p = parse(`max-age=${SECONDS_IN_YEAR}; preload`);
    assert.equal(isPreloadEligible(p), false);
  });
  test('null parsed returns false', () => {
    assert.equal(isPreloadEligible(null), false);
  });
});

describe('round-trip', () => {
  test('build → parse → same fields', () => {
    const h = build({ maxAge: SECONDS_IN_YEAR, includeSubDomains: true, preload: true });
    const p = parse(h);
    assert.equal(p.maxAge, SECONDS_IN_YEAR);
    assert.equal(p.includeSubDomains, true);
    assert.equal(p.preload, true);
  });
});
