'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  repairJson,
  stripCodeFence,
  sliceJsonSpan,
  balanceBrackets,
  stripTrailingCommas,
  singleToDoubleQuotes,
} = require('../src/services/ai-product-os/json-repair');

describe('stripCodeFence', () => {
  test('removes ```json fence', () => {
    assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  });
  test('removes plain ``` fence', () => {
    assert.equal(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}');
  });
  test('passthrough when no fence', () => {
    assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
  });
  test('handles empty / non-string', () => {
    assert.equal(stripCodeFence(''), '');
    assert.equal(stripCodeFence(null), '');
  });
});

describe('sliceJsonSpan', () => {
  test('drops leading prose and trailing commentary', () => {
    const out = sliceJsonSpan('Sure! Here you go: {"a":1, "b":[1,2,3]} hope that helps');
    assert.equal(out, '{"a":1, "b":[1,2,3]}');
  });
  test('respects strings containing braces', () => {
    const out = sliceJsonSpan('{"a":"}{}", "b":1}');
    assert.equal(out, '{"a":"}{}", "b":1}');
  });
  test('handles array root', () => {
    const out = sliceJsonSpan('answer: [1,2,3] (done)');
    assert.equal(out, '[1,2,3]');
  });
  test('returns text from start when no closer found', () => {
    const out = sliceJsonSpan('{"a":1, "b":2');
    assert.equal(out, '{"a":1, "b":2');
  });
});

describe('balanceBrackets', () => {
  test('appends missing }', () => {
    assert.equal(balanceBrackets('{"a":1'), '{"a":1}');
  });
  test('appends missing ]', () => {
    assert.equal(balanceBrackets('[1,2,3'), '[1,2,3]');
  });
  test('ignores braces inside strings', () => {
    assert.equal(balanceBrackets('{"a":"}{"}'), '{"a":"}{"}');
  });
});

describe('stripTrailingCommas', () => {
  test('removes commas before } and ]', () => {
    assert.equal(stripTrailingCommas('{"a":1,}'), '{"a":1}');
    assert.equal(stripTrailingCommas('[1,2,3,]'), '[1,2,3]');
  });
});

describe('singleToDoubleQuotes', () => {
  test('replaces single quotes when no double present', () => {
    assert.equal(singleToDoubleQuotes("{'a':'b'}"), '{"a":"b"}');
  });
  test('leaves alone when double quotes already present', () => {
    assert.equal(singleToDoubleQuotes(`{"a":'b'}`), `{"a":'b'}`);
  });
});

describe('repairJson — happy paths', () => {
  test('clean JSON parses without repairs', () => {
    const r = repairJson('{"a":1}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: 1 });
    assert.deepEqual(r.repairs, []);
  });

  test('strips ```json fence and parses', () => {
    const r = repairJson('```json\n{"a":1}\n```');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: 1 });
    assert.ok(r.repairs.includes('strip_code_fence'));
  });

  test('strips trailing prose and parses', () => {
    const r = repairJson('Here you go: {"a":[1,2]} all good');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: [1, 2] });
  });

  test('balances missing closing brace', () => {
    const r = repairJson('{"a":{"b":1');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: { b: 1 } });
    assert.ok(r.repairs.includes('balance_brackets'));
  });

  test('removes trailing commas', () => {
    const r = repairJson('{"a":[1,2,3,],}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: [1, 2, 3] });
  });

  test('single-quoted object becomes valid JSON', () => {
    const r = repairJson("{'a':'hello'}");
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: 'hello' });
    assert.ok(r.repairs.includes('single_to_double_quotes'));
  });
});

describe('repairJson — failure paths', () => {
  test('empty input returns ok:false', () => {
    const r = repairJson('');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'empty input');
  });

  test('non-string returns ok:false', () => {
    const r = repairJson(null);
    assert.equal(r.ok, false);
  });

  test('hopelessly malformed surfaces parse error + repaired text', () => {
    const r = repairJson('{this: is, not: json: at: all');
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.ok(typeof r.repaired === 'string');
  });
});

describe('repairJson — composite scenarios', () => {
  test('fenced + missing brace + trailing comma', () => {
    const r = repairJson('```json\n{"items":[1,2,3,], "ok":true\n```');
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { items: [1, 2, 3], ok: true });
    assert.ok(r.repairs.includes('strip_code_fence'));
    assert.ok(r.repairs.includes('balance_brackets') || r.repairs.includes('strip_trailing_commas'));
  });

  test('reports originalLength and repaired snippet', () => {
    const input = '   {"a":1}   ';
    const r = repairJson(input);
    assert.equal(r.originalLength, input.length);
    assert.equal(r.repaired, '{"a":1}');
  });
});
