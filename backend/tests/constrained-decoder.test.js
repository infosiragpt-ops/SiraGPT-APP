'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const {
  JsonStreamValidator,
  GrammarValidator,
  buildRepairPrompt,
  validateToolCallArgs,
  DecoderError,
  validateValue,
} = require('../src/services/agents/constrained-decoder');

// ── JsonStreamValidator ──────────────────────────────────────────────

describe('JsonStreamValidator — well-formed inputs', () => {
  let v;
  beforeEach(() => { v = new JsonStreamValidator(); });

  it('accepts a simple object fed all at once', () => {
    const r = v.feed('{"a":1}');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(v.isComplete(), true);
    assert.deepStrictEqual(v.result(), { a: 1 });
  });

  it('accepts the same object fed character by character', () => {
    let last = { valid: true };
    for (const ch of '{"a":1}') last = v.feed(ch);
    assert.strictEqual(last.valid, true);
    assert.strictEqual(v.isComplete(), true);
  });

  it('handles whitespace anywhere outside strings', () => {
    const r = v.feed(' { "a" : 1 ,  "b"  :  2 } ');
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(v.result(), { a: 1, b: 2 });
  });

  it('handles nested arrays and objects', () => {
    const json = '{"a":[1,2,{"b":[true,null,false]}]}';
    let last;
    for (const ch of json) last = v.feed(ch);
    assert.strictEqual(last.valid, true);
    assert.strictEqual(v.isComplete(), true);
    assert.deepStrictEqual(v.result(), { a: [1, 2, { b: [true, null, false] }] });
  });

  it('handles escaped characters in strings', () => {
    const json = '{"s":"line1\\nline2\\\"quoted\\\""}';
    const r = v.feed(json);
    assert.strictEqual(r.valid, true);
    assert.strictEqual(v.isComplete(), true);
  });

  it('handles empty arrays and objects', () => {
    assert.strictEqual(v.feed('{}').valid, true);
    assert.strictEqual(v.isComplete(), true);
    const v2 = new JsonStreamValidator();
    assert.strictEqual(v2.feed('[]').valid, true);
    assert.strictEqual(v2.isComplete(), true);
  });

  it('handles negative and decimal numbers', () => {
    assert.strictEqual(v.feed('[-1.5,0,2e10,3.14e-2]').valid, true);
    assert.strictEqual(v.isComplete(), true);
  });

  it('handles top-level scalar string', () => {
    assert.strictEqual(v.feed('"hello"').valid, true);
    assert.strictEqual(v.isComplete(), true);
  });

  it('handles top-level scalar number', () => {
    let last;
    for (const ch of '42') last = v.feed(ch);
    last = v.feed(' '); // trailing whitespace settles the number
    assert.strictEqual(last.valid, true);
    assert.strictEqual(v.isComplete(), true);
  });

  it('handles top-level literal true/false/null', () => {
    for (const lit of ['true', 'false', 'null']) {
      const vv = new JsonStreamValidator();
      const r = vv.feed(lit);
      assert.strictEqual(r.valid, true, `literal ${lit}`);
      assert.strictEqual(vv.isComplete(), true, `${lit} complete`);
    }
  });
});

describe('JsonStreamValidator — malformed inputs', () => {
  let v;
  beforeEach(() => { v = new JsonStreamValidator(); });

  it('rejects unquoted key', () => {
    // Feed character-by-character so we capture the FIRST violation;
    // .feed() continues processing after a fail, so the last char's
    // result may be valid even though earlier chars violated.
    let r;
    for (const ch of '{a:1}') {
      r = v.feed(ch);
      if (!r.valid) break;
    }
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'expected_key');
  });

  it('rejects missing colon after key', () => {
    let last;
    for (const ch of '{"a"1}') last = v.feed(ch);
    assert.strictEqual(last.valid, false);
    assert.strictEqual(last.reason, 'expected_colon');
  });

  it('rejects missing comma between values', () => {
    let r;
    for (const ch of '[1 2]') {
      r = v.feed(ch);
      if (!r.valid) break;
    }
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'expected_comma_or_close');
  });

  it('rejects mismatched closing bracket', () => {
    const r = v.feed('[1,2}');
    assert.strictEqual(r.valid, false);
  });

  it('rejects unescaped newline in string', () => {
    let r;
    for (const ch of '"abc\n"') {
      r = v.feed(ch);
      if (!r.valid) break;
    }
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'unescaped_newline_in_string');
  });

  it('rejects invalid escape sequences', () => {
    let r;
    for (const ch of '"\\q"') {
      r = v.feed(ch);
      if (!r.valid) break;
    }
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'invalid_escape');
  });

  it('rejects malformed literal', () => {
    let last;
    for (const ch of 'truX') last = v.feed(ch);
    assert.strictEqual(last.valid, false);
    assert.strictEqual(last.reason, 'invalid_literal');
  });

  it('records every violation seen in .violations', () => {
    v.feed('{a:b'); // two violations: unquoted key, then unquoted value
    assert.ok(v.violations.length >= 1);
  });
});

describe('JsonStreamValidator — schema validation', () => {
  it('passes when value matches schema', () => {
    const v = new JsonStreamValidator();
    v.setSchema({ type: 'object', required: ['name'], properties: { name: { type: 'string' } } });
    v.feed('{"name":"alice"}');
    const r = v.validateAgainstSchema();
    assert.strictEqual(r.valid, true);
  });

  it('reports missing required property', () => {
    const v = new JsonStreamValidator();
    v.setSchema({ type: 'object', required: ['name'], properties: { name: { type: 'string' } } });
    v.feed('{"other":1}');
    const r = v.validateAgainstSchema();
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'missing_required');
  });

  it('reports type mismatch', () => {
    const v = new JsonStreamValidator();
    v.setSchema({ type: 'object', properties: { age: { type: 'integer' } } });
    v.feed('{"age":"old"}');
    const r = v.validateAgainstSchema();
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'type_mismatch');
  });

  it('reports enum mismatch', () => {
    const v = new JsonStreamValidator();
    v.setSchema({ type: 'object', properties: { color: { enum: ['red', 'blue'] } } });
    v.feed('{"color":"green"}');
    const r = v.validateAgainstSchema();
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'enum_mismatch');
  });

  it('returns valid:false with reason:incomplete on partial input', () => {
    const v = new JsonStreamValidator();
    v.setSchema({ type: 'object', required: ['x'] });
    v.feed('{"x":');
    const r = v.validateAgainstSchema();
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'incomplete');
  });

  it('rejects non-object schema in setSchema', () => {
    const v = new JsonStreamValidator();
    assert.throws(() => v.setSchema(42), DecoderError);
  });

  it('validates array minItems / maxItems', () => {
    const r = validateValue([1], { type: 'array', minItems: 2 }, '$');
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'min_items');

    const r2 = validateValue([1, 2, 3], { type: 'array', maxItems: 2 }, '$');
    assert.strictEqual(r2.valid, false);
    assert.strictEqual(r2.reason, 'max_items');
  });

  it('validates nested array items', () => {
    const r = validateValue([1, 'two'], { type: 'array', items: { type: 'integer' } }, '$');
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'type_mismatch');
  });
});

// ── GrammarValidator ─────────────────────────────────────────────────

describe('GrammarValidator — construction', () => {
  it('rejects missing start', () => {
    assert.throws(() => new GrammarValidator({ rules: [{ lhs: 'S', rhs: ['a'] }] }), DecoderError);
  });

  it('rejects empty rules', () => {
    assert.throws(() => new GrammarValidator({ start: 'S', rules: [] }), DecoderError);
  });
});

describe('GrammarValidator — simple language', () => {
  // S -> a S | a
  const grammar = {
    start: 'S',
    rules: [
      { lhs: 'S', rhs: ['a', 'S'] },
      { lhs: 'S', rhs: ['a'] },
    ],
  };

  it('accepts "a"', () => {
    const v = new GrammarValidator(grammar);
    assert.strictEqual(v.feed('a').valid, true);
    assert.strictEqual(v.complete(), true);
  });

  it('accepts "aaa"', () => {
    const v = new GrammarValidator(grammar);
    v.feed('a'); v.feed('a'); v.feed('a');
    assert.strictEqual(v.complete(), true);
  });

  it('rejects "ab" (b not in language)', () => {
    const v = new GrammarValidator(grammar);
    v.feed('a');
    const r = v.feed('b');
    assert.strictEqual(r.valid, false);
    assert.strictEqual(v.complete(), false);
  });

  it('reset() clears the chart', () => {
    const v = new GrammarValidator(grammar);
    v.feed('a');
    v.reset();
    assert.strictEqual(v.complete(), false); // empty input → not complete (need at least one 'a')
    assert.strictEqual(v.feed('a').valid, true);
    assert.strictEqual(v.complete(), true);
  });
});

describe('GrammarValidator — arithmetic-style grammar', () => {
  // E -> T '+' E | T
  // T -> 'n' '*' T | 'n'
  const grammar = {
    start: 'E',
    rules: [
      { lhs: 'E', rhs: ['T', '+', 'E'] },
      { lhs: 'E', rhs: ['T'] },
      { lhs: 'T', rhs: ['n', '*', 'T'] },
      { lhs: 'T', rhs: ['n'] },
    ],
  };

  it('accepts "n + n * n"', () => {
    const v = new GrammarValidator(grammar);
    for (const tok of ['n', '+', 'n', '*', 'n']) v.feed(tok);
    assert.strictEqual(v.complete(), true);
  });

  it('rejects trailing operator "n +"', () => {
    const v = new GrammarValidator(grammar);
    v.feed('n'); v.feed('+');
    assert.strictEqual(v.complete(), false);
  });

  it('rejects unbalanced "+ n"', () => {
    const v = new GrammarValidator(grammar);
    const r = v.feed('+');
    assert.strictEqual(r.valid, false);
  });
});

// ── buildRepairPrompt ────────────────────────────────────────────────

describe('buildRepairPrompt', () => {
  const orig = 'Generate a JSON object {"name": str, "age": int}.';

  it('rejects empty originalPrompt', () => {
    assert.throws(() => buildRepairPrompt({ violation: { reason: 'x' } }), DecoderError);
  });

  it('rejects missing violation', () => {
    assert.throws(() => buildRepairPrompt({ originalPrompt: orig }), DecoderError);
  });

  it('produces a repair prompt with all violation context inlined', () => {
    const out = buildRepairPrompt({
      originalPrompt: orig,
      violation: {
        reason: 'type_mismatch',
        position: 42,
        path: '$.age',
        expected: 'integer',
        got: 'string',
      },
      attempt: 2,
    });
    assert.match(out, /REPAIR ATTEMPT 2/);
    assert.match(out, /type_mismatch/);
    assert.match(out, /near offset 42/);
    assert.match(out, /path \$\.age/);
    assert.match(out, /Expected: "integer"/);
    assert.match(out, /Got: "string"/);
    assert.match(out, /Generate a JSON object/);
  });

  it('handles violation with missing optional fields', () => {
    const out = buildRepairPrompt({
      originalPrompt: orig,
      violation: { reason: 'unknown' },
    });
    assert.match(out, /REPAIR ATTEMPT 1/);
    assert.match(out, /Reason: unknown/);
  });
});

// ── validateToolCallArgs ─────────────────────────────────────────────

describe('validateToolCallArgs', () => {
  const manifest = {
    name: 'web_search',
    inputs: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        topK: { type: 'integer' },
      },
    },
  };

  it('passes when args match manifest schema', () => {
    const r = validateToolCallArgs(manifest, { query: 'cats', topK: 5 });
    assert.strictEqual(r.valid, true);
  });

  it('reports missing required field', () => {
    const r = validateToolCallArgs(manifest, { topK: 5 });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'missing_required');
  });

  it('reports type mismatch', () => {
    const r = validateToolCallArgs(manifest, { query: 'cats', topK: 'five' });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'type_mismatch');
  });

  it('passes when manifest has no inputs schema', () => {
    const r = validateToolCallArgs({ name: 't' }, { anything: 1 });
    assert.strictEqual(r.valid, true);
  });

  it('rejects missing manifest', () => {
    assert.throws(() => validateToolCallArgs(null, {}), DecoderError);
  });
});

// ── validateValue (exported for direct testing) ──────────────────────

describe('validateValue', () => {
  it('accepts any value when schema is empty', () => {
    assert.strictEqual(validateValue({}, {}, '$').valid, true);
    assert.strictEqual(validateValue('x', {}, '$').valid, true);
  });

  it('integer must be integer not float', () => {
    assert.strictEqual(validateValue(1.5, { type: 'integer' }, '$').valid, false);
    assert.strictEqual(validateValue(2, { type: 'integer' }, '$').valid, true);
  });

  it('null type matches null only', () => {
    assert.strictEqual(validateValue(null, { type: 'null' }, '$').valid, true);
    assert.strictEqual(validateValue(0, { type: 'null' }, '$').valid, false);
  });

  it('object type rejects arrays', () => {
    assert.strictEqual(validateValue([], { type: 'object' }, '$').valid, false);
  });
});
