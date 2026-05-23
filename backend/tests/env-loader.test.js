'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  loadEnv,
  describeSchema,
  EnvValidationError,
  coerce,
} = require('../src/utils/env-loader');

describe('coerce — type coercion', () => {
  test('string passthrough', () => {
    assert.equal(coerce('hello', { type: 'string' }), 'hello');
  });
  test('number / integer', () => {
    assert.equal(coerce('42', { type: 'number' }), 42);
    assert.equal(coerce('3.14', { type: 'number' }), 3.14);
    assert.equal(coerce('5', { type: 'integer' }), 5);
    assert.throws(() => coerce('5.5', { type: 'integer' }));
    assert.throws(() => coerce('abc', { type: 'number' }));
  });
  test('boolean truthy/falsy literals', () => {
    for (const t of ['1', 'true', 'YES', ' on ']) assert.equal(coerce(t, { type: 'boolean' }), true);
    for (const f of ['0', 'false', 'no', 'OFF']) assert.equal(coerce(f, { type: 'boolean' }), false);
    assert.throws(() => coerce('maybe', { type: 'boolean' }));
  });
  test('json', () => {
    assert.deepEqual(coerce('{"a":1}', { type: 'json' }), { a: 1 });
    assert.throws(() => coerce('not json', { type: 'json' }));
  });
  test('list splits + trims + drops empty', () => {
    assert.deepEqual(coerce('a, b ,,c', { type: 'list' }), ['a', 'b', 'c']);
  });
  test('enum allows declared choices, rejects others', () => {
    assert.equal(coerce('prod', { type: 'enum', choices: ['dev', 'prod'] }), 'prod');
    assert.throws(() => coerce('staging', { type: 'enum', choices: ['dev', 'prod'] }));
  });
  test('custom parser overrides type', () => {
    const v = coerce('5,10', { type: 'string', parser: (s) => s.split(',').map(Number) });
    assert.deepEqual(v, [5, 10]);
  });
  test('unknown type throws', () => {
    assert.throws(() => coerce('x', { type: 'banana' }));
  });
});

describe('loadEnv — happy path', () => {
  test('required + present', () => {
    const out = loadEnv(
      { PORT: { type: 'integer', required: true } },
      { PORT: '3000' },
    );
    assert.equal(out.PORT, 3000);
  });

  test('default applied when missing', () => {
    const out = loadEnv({ TIMEOUT: { type: 'integer', default: 5000 } }, {});
    assert.equal(out.TIMEOUT, 5000);
  });

  test('present overrides default', () => {
    const out = loadEnv({ TIMEOUT: { type: 'integer', default: 5000 } }, { TIMEOUT: '999' });
    assert.equal(out.TIMEOUT, 999);
  });

  test('returned object is frozen', () => {
    const out = loadEnv({ X: { type: 'string', default: 'a' } }, {});
    assert.throws(() => { out.X = 'b'; }, TypeError);
  });

  test('multi-key schema', () => {
    const out = loadEnv({
      MODE: { type: 'enum', choices: ['dev', 'prod'], default: 'dev' },
      DEBUG: { type: 'boolean', default: false },
      TAGS: { type: 'list', default: [] },
    }, { MODE: 'prod', DEBUG: 'true', TAGS: 'a,b,c' });
    assert.equal(out.MODE, 'prod');
    assert.equal(out.DEBUG, true);
    assert.deepEqual(out.TAGS, ['a', 'b', 'c']);
  });
});

describe('loadEnv — failure aggregation', () => {
  test('missing required surfaces typed error with key list', () => {
    try {
      loadEnv(
        {
          DB_URL: { type: 'string', required: true },
          API_KEY: { type: 'string', required: true },
        },
        {},
      );
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof EnvValidationError);
      assert.equal(e.errors.length, 2);
      assert.deepEqual(e.errors.map((r) => r.key).sort(), ['API_KEY', 'DB_URL']);
    }
  });

  test('bad coercion is surfaced (not silently swallowed)', () => {
    try {
      loadEnv({ N: { type: 'integer', required: true } }, { N: 'banana' });
      assert.fail('should throw');
    } catch (e) {
      assert.equal(e.errors[0].key, 'N');
      assert.match(e.errors[0].error, /number|integer/);
    }
  });

  test('empty string treated as missing', () => {
    assert.throws(
      () => loadEnv({ X: { type: 'string', required: true } }, { X: '' }),
      EnvValidationError,
    );
  });

  test('missing-not-required absent key returns undefined slot', () => {
    const out = loadEnv({ X: { type: 'string' } }, {});
    assert.equal(out.X, undefined);
  });

  test('invalid schema entry surfaces error', () => {
    assert.throws(
      () => loadEnv({ X: 'not-an-object' }, {}),
      EnvValidationError,
    );
  });
});

describe('loadEnv — guards', () => {
  test('rejects non-object schema', () => {
    assert.throws(() => loadEnv(null, {}), TypeError);
  });
});

describe('describeSchema', () => {
  test('returns markdown table with column header + rows', () => {
    const md = describeSchema({
      PORT: { type: 'integer', required: true },
      DEBUG: { type: 'boolean', default: false },
    });
    assert.match(md, /\| key \| type \| required \| default \|/);
    assert.match(md, /PORT/);
    assert.match(md, /DEBUG/);
  });

  test('secret defaults are masked', () => {
    const md = describeSchema({
      SECRET: { type: 'string', default: 'p4ss', secret: true },
    });
    assert.match(md, /«secret»/);
  });
});
