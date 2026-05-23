/**
 * Tests for services/agent-runtime/parsers.js — JSON output parser
 * + lightweight JSON Schema validator for LLM-emitted JSON.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  OutputParserError,
  parseJsonStrict,
  parseWithSchema,
  validateJsonSchema,
} = require('../src/services/agent-runtime/parsers');

// ── OutputParserError ───────────────────────────────────────────────

describe('OutputParserError', () => {
  it('has name "OutputParserError" and code "output_parser_error"', () => {
    const err = new OutputParserError('x');
    assert.equal(err.name, 'OutputParserError');
    assert.equal(err.code, 'output_parser_error');
    assert.ok(err instanceof Error);
  });

  it('stores details on the error object', () => {
    const err = new OutputParserError('x', { foo: 'bar' });
    assert.deepEqual(err.details, { foo: 'bar' });
  });

  it('defaults details to {} when not provided', () => {
    const err = new OutputParserError('x');
    assert.deepEqual(err.details, {});
  });
});

// ── parseJsonStrict ─────────────────────────────────────────────────

describe('parseJsonStrict', () => {
  it('returns the input unchanged when already an object', () => {
    const obj = { a: 1, b: 'two' };
    assert.strictEqual(parseJsonStrict(obj), obj);
  });

  it('parses a valid JSON string', () => {
    assert.deepEqual(parseJsonStrict('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonStrict('[1,2,3]'), [1, 2, 3]);
  });

  it('throws OutputParserError on non-string non-object input', () => {
    for (const v of [42, true, null, undefined]) {
      assert.throws(() => parseJsonStrict(v), OutputParserError);
    }
  });

  it('throws OutputParserError on malformed JSON string', () => {
    try {
      parseJsonStrict('{not: valid}');
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof OutputParserError);
      assert.match(e.message, /Invalid JSON output/);
      assert.ok(e.details.preview);
    }
  });

  it('truncates the preview to 500 chars in the error', () => {
    const bad = '{' + 'a'.repeat(2000);
    try {
      parseJsonStrict(bad);
    } catch (e) {
      assert.ok(e.details.preview.length <= 500);
    }
  });
});

// ── validateJsonSchema ─────────────────────────────────────────────

describe('validateJsonSchema · type checks', () => {
  it('passes for primitive type matches', () => {
    assert.equal(validateJsonSchema('hi', { type: 'string' }).ok, true);
    assert.equal(validateJsonSchema(42, { type: 'number' }).ok, true);
    assert.equal(validateJsonSchema(true, { type: 'boolean' }).ok, true);
    assert.equal(validateJsonSchema(null, { type: 'null' }).ok, true);
  });

  it('integer type rejects floats', () => {
    assert.equal(validateJsonSchema(3, { type: 'integer' }).ok, true);
    assert.equal(validateJsonSchema(3.5, { type: 'integer' }).ok, false);
  });

  it('number type rejects NaN and Infinity', () => {
    assert.equal(validateJsonSchema(NaN, { type: 'number' }).ok, false);
    assert.equal(validateJsonSchema(Infinity, { type: 'number' }).ok, false);
  });

  it('array vs object are disjoint (typeof object split)', () => {
    assert.equal(validateJsonSchema([], { type: 'object' }).ok, false);
    assert.equal(validateJsonSchema({}, { type: 'array' }).ok, false);
    assert.equal(validateJsonSchema([], { type: 'array' }).ok, true);
    assert.equal(validateJsonSchema({}, { type: 'object' }).ok, true);
  });

  it('union types accept any of the listed types', () => {
    assert.equal(validateJsonSchema('hi', { type: ['string', 'null'] }).ok, true);
    assert.equal(validateJsonSchema(null, { type: ['string', 'null'] }).ok, true);
    assert.equal(validateJsonSchema(42, { type: ['string', 'null'] }).ok, false);
  });

  it('reports type_mismatch with expected + actual', () => {
    const r = validateJsonSchema(42, { type: 'string' });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'type_mismatch');
    assert.equal(r.errors[0].expected, 'string');
    assert.equal(r.errors[0].actual, 'number');
  });
});

describe('validateJsonSchema · enum checks', () => {
  it('passes when value is in enum', () => {
    const r = validateJsonSchema('asc', { enum: ['asc', 'desc'] });
    assert.equal(r.ok, true);
  });

  it('flags enum_mismatch when value is not in enum', () => {
    const r = validateJsonSchema('sideways', { enum: ['asc', 'desc'] });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'enum_mismatch');
    assert.deepEqual(r.errors[0].expected, ['asc', 'desc']);
    assert.equal(r.errors[0].actual, 'sideways');
  });
});

describe('validateJsonSchema · object schemas', () => {
  const userSchema = {
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      role: { enum: ['admin', 'user'] },
    },
  };

  it('passes for a fully-valid object', () => {
    const r = validateJsonSchema({ id: 1, name: 'Ada', role: 'admin' }, userSchema);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it('flags missing required fields', () => {
    const r = validateJsonSchema({ name: 'Ada' }, userSchema);
    assert.equal(r.ok, false);
    const missing = r.errors.find((e) => e.code === 'required');
    assert.ok(missing);
    assert.match(missing.path, /\.id$/);
  });

  it('flags type mismatch on a nested property', () => {
    const r = validateJsonSchema({ id: 'not-an-int', name: 'Ada' }, userSchema);
    const mismatch = r.errors.find((e) => e.code === 'type_mismatch');
    assert.ok(mismatch);
    assert.match(mismatch.path, /\.id$/);
  });

  it('flags enum mismatch on a nested property', () => {
    const r = validateJsonSchema({ id: 1, name: 'Ada', role: 'goblin' }, userSchema);
    const enumErr = r.errors.find((e) => e.code === 'enum_mismatch');
    assert.ok(enumErr);
    assert.match(enumErr.path, /\.role$/);
  });

  it('does not recurse properties when value is not an object', () => {
    // value is null → required check still hits, but no nested
    // recursion (would crash on null.id otherwise).
    const r = validateJsonSchema(null, userSchema);
    assert.equal(r.ok, false);
    // Type mismatch is the primary error.
    assert.ok(r.errors.some((e) => e.code === 'type_mismatch'));
  });
});

describe('validateJsonSchema · array schemas', () => {
  it('validates every item against schema.items', () => {
    const r = validateJsonSchema([1, 2, 3, 4], { type: 'array', items: { type: 'integer' } });
    assert.equal(r.ok, true);
  });

  it('flags the failing index in path', () => {
    const r = validateJsonSchema([1, 'two', 3], { type: 'array', items: { type: 'integer' } });
    assert.equal(r.ok, false);
    const err = r.errors[0];
    assert.match(err.path, /\$\[1\]/);
  });

  it('does not throw when schema lacks an items spec', () => {
    const r = validateJsonSchema([1, 'two', null], { type: 'array' });
    assert.equal(r.ok, true);
  });
});

describe('validateJsonSchema · result shape', () => {
  it('result object is frozen', () => {
    const r = validateJsonSchema(1, { type: 'integer' });
    assert.throws(() => { r.ok = false; }, TypeError);
  });

  it('always includes the original value', () => {
    const r = validateJsonSchema({ x: 1 }, { type: 'object' });
    assert.deepEqual(r.value, { x: 1 });
  });

  it('empty schema accepts anything', () => {
    assert.equal(validateJsonSchema(1, {}).ok, true);
    assert.equal(validateJsonSchema('x', {}).ok, true);
    assert.equal(validateJsonSchema(null, {}).ok, true);
  });
});

// ── parseWithSchema ────────────────────────────────────────────────

describe('parseWithSchema', () => {
  it('parses a JSON string AND validates it against a schema in one step', () => {
    const out = parseWithSchema('{"id":1,"name":"Ada"}', {
      type: 'object',
      required: ['id', 'name'],
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
    });
    assert.deepEqual(out, { id: 1, name: 'Ada' });
  });

  it('throws OutputParserError when JSON is malformed', () => {
    assert.throws(
      () => parseWithSchema('not json', { type: 'object' }),
      OutputParserError,
    );
  });

  it('throws OutputParserError with errors list when schema fails', () => {
    try {
      parseWithSchema('{"id":"oops"}', {
        type: 'object',
        properties: { id: { type: 'integer' } },
      });
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof OutputParserError);
      assert.match(e.message, /Output does not match schema/);
      assert.ok(Array.isArray(e.details.errors));
      assert.ok(e.details.errors.length > 0);
    }
  });

  it('accepts an already-parsed object (no double-parse)', () => {
    const out = parseWithSchema({ id: 1 }, { type: 'object' });
    assert.deepEqual(out, { id: 1 });
  });
});
