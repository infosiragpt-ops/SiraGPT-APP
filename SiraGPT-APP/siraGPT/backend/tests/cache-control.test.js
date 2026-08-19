'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parseCacheControl, buildCacheControl, freshness } = require('../src/utils/cache-control');

describe('parseCacheControl', () => {
  test('boolean directive', () => {
    assert.deepEqual(parseCacheControl('no-store'), { 'no-store': true });
  });
  test('value directive', () => {
    assert.deepEqual(parseCacheControl('max-age=300'), { 'max-age': 300 });
  });
  test('mixed directives', () => {
    const r = parseCacheControl('public, max-age=60, must-revalidate');
    assert.equal(r.public, true);
    assert.equal(r['max-age'], 60);
    assert.equal(r['must-revalidate'], true);
  });
  test('lowercases names', () => {
    assert.equal(parseCacheControl('No-Store')['no-store'], true);
  });
  test('strips quotes from value', () => {
    const r = parseCacheControl('private="X-Custom"');
    assert.equal(r.private, 'X-Custom');
  });
  test('non-finite max-age clamped to 0', () => {
    assert.equal(parseCacheControl('max-age=NaN')['max-age'], 0);
    assert.equal(parseCacheControl('max-age=-5')['max-age'], 0);
  });
  test('null/empty returns {}', () => {
    assert.deepEqual(parseCacheControl(''), {});
    assert.deepEqual(parseCacheControl(null), {});
  });
});

describe('buildCacheControl', () => {
  test('emits boolean directives sorted before value directives', () => {
    const r = buildCacheControl({ public: true, 'must-revalidate': true, 'max-age': 60 });
    assert.equal(r, 'must-revalidate, public, max-age=60');
  });

  test('false / null directives omitted', () => {
    const r = buildCacheControl({ public: true, private: false, 'no-store': null });
    assert.equal(r, 'public');
  });

  test('numeric values floored + clamped at 0', () => {
    const r = buildCacheControl({ 'max-age': -10 });
    assert.equal(r, 'max-age=0');
    const r2 = buildCacheControl({ 'max-age': 60.7 });
    assert.equal(r2, 'max-age=60');
  });

  test('string with whitespace gets quoted', () => {
    const r = buildCacheControl({ private: 'X-Header, X-Other' });
    assert.match(r, /private="X-Header, X-Other"/);
  });

  test('non-object input → empty string', () => {
    assert.equal(buildCacheControl(null), '');
    assert.equal(buildCacheControl('nope'), '');
  });
});

describe('roundtrip parse + build', () => {
  test('two equivalent directive sets canonicalize identically', () => {
    const a = buildCacheControl(parseCacheControl('public, max-age=60, must-revalidate'));
    const b = buildCacheControl(parseCacheControl('must-revalidate, max-age=60, public'));
    assert.equal(a, b);
  });
});

describe('freshness', () => {
  test('age under max-age → fresh', () => {
    const parsed = parseCacheControl('public, max-age=60');
    assert.deepEqual(freshness(parsed, 30), { fresh: true, reason: 'fresh', maxAge: 60 });
  });
  test('age over max-age → expired', () => {
    const parsed = parseCacheControl('public, max-age=10');
    const r = freshness(parsed, 100);
    assert.equal(r.fresh, false);
    assert.equal(r.reason, 'expired');
  });
  test('s-maxage takes precedence', () => {
    const parsed = parseCacheControl('public, max-age=60, s-maxage=10');
    assert.equal(freshness(parsed, 30).fresh, false);
  });
  test('no-store → not fresh', () => {
    assert.equal(freshness(parseCacheControl('no-store'), 0).fresh, false);
  });
  test('no-cache → not fresh', () => {
    assert.equal(freshness(parseCacheControl('no-cache'), 0).fresh, false);
  });
  test('no max-age → not fresh', () => {
    assert.equal(freshness(parseCacheControl('public'), 0).fresh, false);
  });
  test('non-object → not fresh', () => {
    assert.equal(freshness(null, 0).fresh, false);
  });
});
