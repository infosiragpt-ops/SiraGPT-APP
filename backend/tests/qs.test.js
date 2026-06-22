'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { stringify, parse } = require('../src/utils/qs');

describe('stringify', () => {
  test('simple key=value', () => {
    assert.equal(stringify({ a: 1, b: 'hi' }), 'a=1&b=hi');
  });

  test('URL-encodes values', () => {
    assert.equal(stringify({ q: 'hello world' }), 'q=hello%20world');
  });

  test('arrayFormat=repeat (default)', () => {
    assert.equal(stringify({ tags: ['a', 'b'] }), 'tags=a&tags=b');
  });

  test('arrayFormat=brackets', () => {
    const out = stringify({ tags: ['a', 'b'] }, { arrayFormat: 'brackets' });
    assert.equal(out, 'tags%5B%5D=a&tags%5B%5D=b');
  });

  test('arrayFormat=indices', () => {
    const out = stringify({ tags: ['a', 'b'] }, { arrayFormat: 'indices' });
    assert.equal(out, 'tags%5B0%5D=a&tags%5B1%5D=b');
  });

  test('arrayFormat=comma', () => {
    // The comma separator stays literal (matches qs / standard convention);
    // individual element values are still encoded.
    assert.equal(stringify({ tags: ['a', 'b'] }, { arrayFormat: 'comma' }), 'tags=a,b');
  });

  test('null / undefined values are skipped', () => {
    assert.equal(stringify({ a: null, b: undefined, c: 1 }), 'c=1');
  });

  test('nested object via brackets', () => {
    const out = stringify({ filter: { kind: 'x', from: 1 } });
    assert.match(out, /filter%5Bkind%5D=x/);
    assert.match(out, /filter%5Bfrom%5D=1/);
  });

  test('sort:true produces stable order', () => {
    assert.equal(stringify({ b: 2, a: 1 }, { sort: true }), 'a=1&b=2');
  });

  test('non-object → empty string', () => {
    assert.equal(stringify(null), '');
    assert.equal(stringify('nope'), '');
  });
});

describe('parse', () => {
  test('basic key=value', () => {
    assert.deepEqual(parse('a=1&b=hi'), { a: '1', b: 'hi' });
  });

  test('leading ? is tolerated', () => {
    assert.deepEqual(parse('?a=1'), { a: '1' });
  });

  test('+ decodes to space', () => {
    assert.deepEqual(parse('q=hello+world'), { q: 'hello world' });
  });

  test('repeated key produces array', () => {
    assert.deepEqual(parse('tags=a&tags=b'), { tags: ['a', 'b'] });
  });

  test('brackets hint produces array even with one entry', () => {
    assert.deepEqual(parse('tags[]=a'), { tags: ['a'] });
  });

  test('indices hint flattens to array key', () => {
    assert.deepEqual(parse('tags[0]=a&tags[1]=b'), { tags: ['a', 'b'] });
  });

  test('explicit indices are honoured even when keys arrive out of order', () => {
    // Regression: used to push in arrival order, ignoring the [n] index.
    assert.deepEqual(parse('a[1]=x&a[0]=y'), { a: ['y', 'x'] });
    // Sparse indices compact their holes.
    assert.deepEqual(parse('a[2]=c&a[0]=a'), { a: ['a', 'c'] });
  });

  test('arrayFormat=comma splits comma-separated values', () => {
    assert.deepEqual(parse('tags=a,b,c', { arrayFormat: 'comma' }), { tags: ['a', 'b', 'c'] });
  });

  test('non-string returns {}', () => {
    assert.deepEqual(parse(null), {});
  });
});

describe('round-trip', () => {
  test('stringify(parse) round-trips simple keys', () => {
    const obj = { a: '1', b: 'hello', c: ['x', 'y'] };
    const s = stringify(obj);
    const back = parse(s);
    assert.deepEqual(back, obj);
  });
});
