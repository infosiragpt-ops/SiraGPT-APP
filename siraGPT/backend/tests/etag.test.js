'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  strongEtag,
  weakEtag,
  parseEtag,
  ifNoneMatchSatisfied,
  ifModifiedSinceSatisfied,
  shouldReturn304,
} = require('../src/services/auth/etag');

describe('strongEtag / weakEtag', () => {
  test('strong is double-quoted hex', () => {
    const t = strongEtag('hello');
    assert.match(t, /^"[0-9a-f]{32}"$/);
  });
  test('weak prefixes W/', () => {
    const t = weakEtag('hello');
    assert.match(t, /^W\/"[0-9a-f]{32}"$/);
  });
  test('deterministic', () => {
    assert.equal(strongEtag('a'), strongEtag('a'));
    assert.notEqual(strongEtag('a'), strongEtag('b'));
  });
  test('accepts Buffer / object input', () => {
    assert.match(strongEtag(Buffer.from('x')), /^"[0-9a-f]{32}"$/);
    assert.match(strongEtag({ x: 1 }), /^"[0-9a-f]{32}"$/);
  });
});

describe('parseEtag', () => {
  test('parses strong etag', () => {
    const r = parseEtag('"abc123"');
    assert.equal(r.tag, 'abc123');
    assert.equal(r.weak, false);
  });
  test('parses weak etag', () => {
    const r = parseEtag('W/"abc123"');
    assert.equal(r.weak, true);
    assert.equal(r.tag, 'abc123');
  });
  test('rejects malformed', () => {
    assert.equal(parseEtag(''), null);
    assert.equal(parseEtag(null), null);
    assert.equal(parseEtag('no-quotes'), null);
  });
});

describe('ifNoneMatchSatisfied', () => {
  test('exact match returns true', () => {
    const e = strongEtag('content');
    assert.equal(ifNoneMatchSatisfied(e, e), true);
  });
  test('* matches anything', () => {
    assert.equal(ifNoneMatchSatisfied('*', strongEtag('x')), true);
  });
  test('different etag → false', () => {
    assert.equal(ifNoneMatchSatisfied(strongEtag('a'), strongEtag('b')), false);
  });
  test('list with one matching entry → true', () => {
    const e = strongEtag('match');
    const list = `${strongEtag('other')}, ${e}`;
    assert.equal(ifNoneMatchSatisfied(list, e), true);
  });
  test('non-string header → false', () => {
    assert.equal(ifNoneMatchSatisfied(null, strongEtag('x')), false);
  });
});

describe('ifModifiedSinceSatisfied', () => {
  test('resource older than header time → true (not modified)', () => {
    const headerTime = 'Tue, 01 Jan 2030 00:00:00 GMT';
    const oldMs = Date.parse('Mon, 01 Jan 2029 00:00:00 GMT');
    assert.equal(ifModifiedSinceSatisfied(headerTime, oldMs), true);
  });
  test('resource newer than header time → false', () => {
    const headerTime = 'Mon, 01 Jan 2020 00:00:00 GMT';
    const newMs = Date.parse('Tue, 01 Jan 2030 00:00:00 GMT');
    assert.equal(ifModifiedSinceSatisfied(headerTime, newMs), false);
  });
  test('unparseable header → false', () => {
    assert.equal(ifModifiedSinceSatisfied('garbage', 1000), false);
  });
});

describe('shouldReturn304', () => {
  test('If-None-Match takes precedence over If-Modified-Since', () => {
    const e = strongEtag('content');
    const r = shouldReturn304({
      etag: e,
      lastModifiedMs: Date.parse('Tue, 01 Jan 2030 00:00:00 GMT'),
      headers: {
        'if-none-match': e,
        'if-modified-since': 'Mon, 01 Jan 2020 00:00:00 GMT', // would say 200
      },
    });
    assert.equal(r, true);
  });
  test('falls back to If-Modified-Since when no INM', () => {
    const r = shouldReturn304({
      lastModifiedMs: Date.parse('Mon, 01 Jan 2020 00:00:00 GMT'),
      headers: { 'if-modified-since': 'Tue, 01 Jan 2030 00:00:00 GMT' },
    });
    assert.equal(r, true);
  });
  test('no relevant headers → false (must serve 200)', () => {
    assert.equal(shouldReturn304({ etag: strongEtag('x') }), false);
  });
});
