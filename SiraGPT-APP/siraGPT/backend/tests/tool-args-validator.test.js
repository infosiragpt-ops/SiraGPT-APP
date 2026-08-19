'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { validate } = require('../src/services/agents/tool-args-validator');

describe('type checks', () => {
  test('string accepts strings', () => {
    assert.equal(validate({ type: 'string' }, 'hi').ok, true);
    assert.equal(validate({ type: 'string' }, 42).ok, false);
  });
  test('integer rejects non-integers', () => {
    assert.equal(validate({ type: 'integer' }, 3).ok, true);
    assert.equal(validate({ type: 'integer' }, 3.5).ok, false);
  });
  test('number accepts integer or float, rejects NaN', () => {
    assert.equal(validate({ type: 'number' }, 3).ok, true);
    assert.equal(validate({ type: 'number' }, 3.5).ok, true);
    assert.equal(validate({ type: 'number' }, NaN).ok, false);
  });
  test('boolean strict', () => {
    assert.equal(validate({ type: 'boolean' }, true).ok, true);
    assert.equal(validate({ type: 'boolean' }, 1).ok, false);
  });
  test('null distinct from object', () => {
    assert.equal(validate({ type: 'null' }, null).ok, true);
    assert.equal(validate({ type: 'object' }, null).ok, false);
  });
  test('array', () => {
    assert.equal(validate({ type: 'array' }, [1, 2]).ok, true);
    assert.equal(validate({ type: 'array' }, { length: 1 }).ok, false);
  });
  test('union types accept any of', () => {
    assert.equal(validate({ type: ['string', 'integer'] }, 'a').ok, true);
    assert.equal(validate({ type: ['string', 'integer'] }, 5).ok, true);
    assert.equal(validate({ type: ['string', 'integer'] }, true).ok, false);
  });
  test('unknown type surfaces unknownType code', () => {
    const r = validate({ type: 'banana' }, 'x');
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'unknownType');
  });
});

describe('enum / pattern / lengths / numeric bounds', () => {
  test('enum match', () => {
    assert.equal(validate({ enum: ['a', 'b'] }, 'a').ok, true);
    assert.equal(validate({ enum: ['a', 'b'] }, 'c').ok, false);
  });
  test('pattern accepts RegExp or string', () => {
    assert.equal(validate({ type: 'string', pattern: '^h' }, 'hello').ok, true);
    assert.equal(validate({ type: 'string', pattern: /^h/ }, 'world').ok, false);
  });
  test('minLength / maxLength', () => {
    assert.equal(validate({ type: 'string', minLength: 3 }, 'ab').ok, false);
    assert.equal(validate({ type: 'string', maxLength: 3 }, 'abcd').ok, false);
  });
  test('minimum / maximum', () => {
    assert.equal(validate({ type: 'number', minimum: 0 }, -1).ok, false);
    assert.equal(validate({ type: 'number', maximum: 100 }, 200).ok, false);
    assert.equal(validate({ type: 'number', minimum: 0, maximum: 100 }, 50).ok, true);
  });
});

describe('arrays — items / minItems / maxItems', () => {
  test('items schema applied per element', () => {
    const r = validate({ type: 'array', items: { type: 'integer' } }, [1, 'x', 3]);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].path, '$[1]');
    assert.equal(r.errors[0].code, 'type');
  });
  test('minItems / maxItems enforced', () => {
    assert.equal(validate({ type: 'array', minItems: 2 }, [1]).ok, false);
    assert.equal(validate({ type: 'array', maxItems: 2 }, [1, 2, 3]).ok, false);
  });
});

describe('objects — required / properties', () => {
  test('required surfaces missing key with path', () => {
    const r = validate({ type: 'object', required: ['name'] }, {});
    assert.equal(r.errors[0].code, 'required');
    assert.equal(r.errors[0].path, '$.name');
  });
  test('properties recursed and pathed', () => {
    const schema = {
      type: 'object',
      properties: {
        user: { type: 'object', properties: { age: { type: 'integer', minimum: 0 } } },
      },
    };
    const r = validate(schema, { user: { age: -1 } });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].path, '$.user.age');
    assert.equal(r.errors[0].code, 'min');
  });
  test('extra properties are allowed (subset behavior)', () => {
    const r = validate({ type: 'object', properties: { a: { type: 'string' } } }, { a: 'x', b: 1 });
    assert.equal(r.ok, true);
  });
});

describe('happy paths', () => {
  test('full nested object validates', () => {
    const schema = {
      type: 'object',
      required: ['query', 'limit'],
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        filters: { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] } },
      },
    };
    const r = validate(schema, { query: 'hello', limit: 10, filters: ['a', 'c'] });
    assert.equal(r.ok, true);
  });
});

describe('multiple errors in one pass', () => {
  test('reports all violations, not just the first', () => {
    const schema = {
      type: 'object',
      required: ['a', 'b'],
      properties: {
        a: { type: 'integer' },
        b: { type: 'string', minLength: 5 },
      },
    };
    const r = validate(schema, { a: 'oops', b: 'no' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.length >= 2);
    const codes = r.errors.map((e) => e.code);
    assert.ok(codes.includes('type'));
    assert.ok(codes.includes('minLength'));
  });
});
