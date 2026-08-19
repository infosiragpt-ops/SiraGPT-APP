'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const s = require('../src/utils/mini-schema');

describe('string', () => {
  test('accepts strings, rejects others', () => {
    assert.equal(s.string().parse('x'), 'x');
    assert.equal(s.string().safeParse(42).ok, false);
  });
  test('min/max length', () => {
    assert.equal(s.string().min(2).safeParse('a').ok, false);
    assert.equal(s.string().max(2).safeParse('abc').ok, false);
  });
  test('regex', () => {
    assert.equal(s.string().regex(/^[a-z]+$/).safeParse('AB').ok, false);
    assert.equal(s.string().regex(/^[a-z]+$/).parse('ab'), 'ab');
  });
});

describe('number', () => {
  test('accepts finite, rejects NaN/Infinity', () => {
    assert.equal(s.number().parse(3), 3);
    assert.equal(s.number().safeParse(NaN).ok, false);
    assert.equal(s.number().safeParse(Infinity).ok, false);
  });
  test('int / min / max', () => {
    assert.equal(s.number().int().safeParse(3.5).ok, false);
    assert.equal(s.number().min(1).safeParse(0).ok, false);
    assert.equal(s.number().max(10).safeParse(11).ok, false);
  });
});

describe('boolean / literal', () => {
  test('boolean strict', () => {
    assert.equal(s.boolean().safeParse(true).ok, true);
    assert.equal(s.boolean().safeParse(1).ok, false);
  });
  test('literal exact match', () => {
    assert.equal(s.literal('admin').safeParse('admin').ok, true);
    assert.equal(s.literal('admin').safeParse('user').ok, false);
  });
});

describe('array', () => {
  test('every item validated', () => {
    const r = s.array(s.number()).safeParse([1, 'x', 3]);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].path, '$[1]');
  });
  test('non-array rejected', () => {
    assert.equal(s.array(s.string()).safeParse('nope').ok, false);
  });
  test('min/max items', () => {
    assert.equal(s.array(s.number()).min(2).safeParse([1]).ok, false);
    assert.equal(s.array(s.number()).max(2).safeParse([1, 2, 3]).ok, false);
  });
  test('items required as schema', () => {
    assert.throws(() => s.array(null), TypeError);
  });
});

describe('object', () => {
  test('shape validated key by key', () => {
    const sch = s.object({
      name: s.string(),
      age: s.number().int(),
    });
    assert.equal(sch.safeParse({ name: 'a', age: 5 }).ok, true);
    const bad = sch.safeParse({ name: 'a', age: 5.5 });
    assert.equal(bad.ok, false);
    assert.equal(bad.errors[0].path, '$.age');
  });

  test('missing required key reports path', () => {
    const sch = s.object({ x: s.string() });
    const r = sch.safeParse({});
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].path, '$.x');
  });

  test('strict rejects unknown keys', () => {
    const sch = s.object({ a: s.string() }).strict();
    const r = sch.safeParse({ a: 'x', extra: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].path, '$.extra');
  });

  test('non-object rejected', () => {
    assert.equal(s.object({ a: s.string() }).safeParse([]).ok, false);
    assert.equal(s.object({ a: s.string() }).safeParse(null).ok, false);
  });
});

describe('union / optional / nullable', () => {
  test('union accepts any branch', () => {
    const sch = s.union(s.string(), s.number());
    assert.equal(sch.parse('a'), 'a');
    assert.equal(sch.parse(42), 42);
    assert.equal(sch.safeParse(true).ok, false);
  });

  test('optional accepts undefined', () => {
    assert.equal(s.optional(s.string()).safeParse(undefined).ok, true);
    assert.equal(s.optional(s.string()).parse('a'), 'a');
    assert.equal(s.optional(s.string()).safeParse(42).ok, false);
  });

  test('nullable accepts null', () => {
    assert.equal(s.nullable(s.string()).safeParse(null).ok, true);
    assert.equal(s.nullable(s.string()).safeParse(undefined).ok, false);
  });

  test('object with optional field', () => {
    const sch = s.object({ a: s.string(), b: s.optional(s.number()) });
    assert.equal(sch.parse({ a: 'x' }).a, 'x');
    assert.equal(sch.parse({ a: 'x', b: 1 }).b, 1);
  });
});

describe('refine', () => {
  test('extra constraint runs after type check', () => {
    const even = s.number().refine((n) => n % 2 === 0, 'must be even');
    assert.equal(even.parse(4), 4);
    const r = even.safeParse(3);
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /even/);
  });
});

describe('parse vs safeParse', () => {
  test('parse throws on invalid', () => {
    assert.throws(() => s.string().parse(42), s.SchemaError);
  });
  test('safeParse never throws', () => {
    const r = s.string().safeParse(42);
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.errors));
  });
});
