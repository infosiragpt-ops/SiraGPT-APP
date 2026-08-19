'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parseRange, formatContentRange, suffixToAbsolute } = require('../src/utils/range-parser');

describe('parseRange — happy path', () => {
  test('absolute range', () => {
    assert.deepEqual(parseRange('bytes=0-499', 1000), [{ start: 0, end: 499 }]);
  });

  test('open-ended range (bytes=N-)', () => {
    assert.deepEqual(parseRange('bytes=500-', 1000), [{ start: 500, end: 999 }]);
  });

  test('suffix range (bytes=-N) → last N bytes', () => {
    assert.deepEqual(parseRange('bytes=-200', 1000), [{ start: 800, end: 999 }]);
  });

  test('multi-range request', () => {
    assert.deepEqual(parseRange('bytes=0-99,500-599', 1000), [
      { start: 0, end: 99 }, { start: 500, end: 599 },
    ]);
  });

  test('end past totalSize is clamped to last byte', () => {
    assert.deepEqual(parseRange('bytes=0-9999', 100), [{ start: 0, end: 99 }]);
  });
});

describe('parseRange — degenerate input', () => {
  test('null header → null (no Range)', () => {
    assert.equal(parseRange(null, 1000), null);
  });
  test('empty string → null', () => {
    assert.equal(parseRange('', 1000), null);
  });
  test('non-bytes unit → unsatisfiable', () => {
    assert.equal(parseRange('items=0-9', 1000), 'unsatisfiable');
  });
  test('reversed range → unsatisfiable', () => {
    assert.equal(parseRange('bytes=500-100', 1000), 'unsatisfiable');
  });
  test('start past totalSize → unsatisfiable', () => {
    assert.equal(parseRange('bytes=2000-2100', 1000), 'unsatisfiable');
  });
  test('non-integer numbers → unsatisfiable', () => {
    assert.equal(parseRange('bytes=abc-def', 1000), 'unsatisfiable');
  });
  test('non-string header → unsatisfiable', () => {
    assert.equal(parseRange(42, 1000), 'unsatisfiable');
  });
  test('missing total size → unsatisfiable', () => {
    assert.equal(parseRange('bytes=0-99'), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-99', -1), 'unsatisfiable');
  });
});

describe('suffixToAbsolute', () => {
  test('returns last N bytes', () => {
    assert.deepEqual(suffixToAbsolute(50, 200), { start: 150, end: 199 });
  });
  test('null on bad input', () => {
    assert.equal(suffixToAbsolute(0, 100), null);
    assert.equal(suffixToAbsolute(-5, 100), null);
    assert.equal(suffixToAbsolute(50, 0), null);
  });
});

describe('formatContentRange', () => {
  test('emits canonical Content-Range string', () => {
    assert.equal(formatContentRange({ start: 0, end: 99 }, 1000), 'bytes 0-99/1000');
  });
  test('throws on missing start/end', () => {
    assert.throws(() => formatContentRange(null, 1000), TypeError);
    assert.throws(() => formatContentRange({ start: 0 }, 1000), TypeError);
  });
});
