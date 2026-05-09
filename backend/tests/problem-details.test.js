'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { problem, isProblem, parseProblem, contentType, DEFAULT_TYPE } = require('../src/utils/problem-details');

describe('problem builder', () => {
  test('default type is about:blank', () => {
    const p = problem({ title: 'Bad Request', status: 400 });
    assert.equal(p.type, DEFAULT_TYPE);
  });

  test('preserves all five standard members', () => {
    const p = problem({
      type: 'https://example.com/probs/out-of-credit',
      title: 'You do not have enough credit.',
      status: 403,
      detail: 'Your current balance is 30, but that costs 50.',
      instance: '/account/12345/msgs/abc',
    });
    assert.equal(p.status, 403);
    assert.match(p.type, /out-of-credit/);
    assert.equal(p.detail, 'Your current balance is 30, but that costs 50.');
  });

  test('preserves extension fields', () => {
    const p = problem({ type: 'about:blank', status: 422, errors: ['x', 'y'], requestId: 'r1' });
    assert.deepEqual(p.errors, ['x', 'y']);
    assert.equal(p.requestId, 'r1');
  });

  test('output is frozen', () => {
    const p = problem({ status: 400 });
    assert.throws(() => { p.status = 500; }, TypeError);
  });

  test('non-object input throws', () => {
    assert.throws(() => problem('nope'), TypeError);
  });

  test('skips undefined extension values', () => {
    const p = problem({ status: 400, foo: undefined });
    assert.equal('foo' in p, false);
  });

  test('non-string title is dropped (type-strict)', () => {
    const p = problem({ status: 400, title: 42 });
    assert.equal('title' in p, false);
  });

  test('non-integer status is dropped', () => {
    const p = problem({ status: 'oops' });
    assert.equal('status' in p, false);
  });
});

describe('isProblem', () => {
  test('true for objects with at least one standard member', () => {
    assert.equal(isProblem({ type: 'about:blank' }), true);
    assert.equal(isProblem({ status: 400 }), true);
    assert.equal(isProblem({ title: 'x' }), true);
  });
  test('false for arrays / primitives / empty objects', () => {
    assert.equal(isProblem([]), false);
    assert.equal(isProblem(null), false);
    assert.equal(isProblem('x'), false);
    assert.equal(isProblem({}), false);
    assert.equal(isProblem({ random: 'thing' }), false);
  });
});

describe('parseProblem', () => {
  test('round-trips a problem JSON', () => {
    const text = JSON.stringify({ type: 'about:blank', title: 'Bad', status: 400, requestId: 'abc' });
    const p = parseProblem(text);
    assert.equal(p.title, 'Bad');
    assert.equal(p.status, 400);
    assert.equal(p.requestId, 'abc');
  });

  test('null on non-JSON', () => {
    assert.equal(parseProblem('not json'), null);
  });

  test('null on JSON that does not look like a problem', () => {
    assert.equal(parseProblem(JSON.stringify({ totally: 'unrelated' })), null);
  });

  test('null on bad input type', () => {
    assert.equal(parseProblem(null), null);
    assert.equal(parseProblem(42), null);
  });
});

describe('exports', () => {
  test('contentType is application/problem+json', () => {
    assert.equal(contentType, 'application/problem+json');
  });
});
