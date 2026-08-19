'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { parseArgs } = require('../src/utils/argv-parser');

describe('parseArgs — basics', () => {
  test('positional only', () => {
    assert.deepEqual(parseArgs(['a', 'b']), { _: ['a', 'b'] });
  });

  test('long flag with value via space', () => {
    assert.deepEqual(parseArgs(['--name', 'alice']), { _: [], name: 'alice' });
  });

  test('long flag with value via =', () => {
    assert.deepEqual(parseArgs(['--port=3000']), { _: [], port: 3000 });
  });

  test('boolean default true when no value', () => {
    assert.deepEqual(parseArgs(['--debug']), { _: [], debug: true });
  });

  test('--no-key sets false', () => {
    assert.deepEqual(parseArgs(['--no-color']), { _: [], color: false });
  });

  test('short flag', () => {
    assert.deepEqual(parseArgs(['-x', '5']), { _: [], x: 5 });
  });

  test('clustered short booleans', () => {
    assert.deepEqual(parseArgs(['-abc']), { _: [], a: true, b: true, c: true });
  });
});

describe('parseArgs — opts', () => {
  test('boolean list keeps next-arg as positional', () => {
    const r = parseArgs(['--debug', 'cmd'], { boolean: ['debug'] });
    assert.equal(r.debug, true);
    assert.deepEqual(r._, ['cmd']);
  });

  test('string list disables coercion', () => {
    const r = parseArgs(['--id=42'], { string: ['id'] });
    assert.equal(r.id, '42'); // not coerced to number
  });

  test('alias maps short to long', () => {
    const r = parseArgs(['-v'], { boolean: ['verbose'], alias: { v: 'verbose' } });
    assert.equal(r.verbose, true);
  });

  test('default merged when not set', () => {
    const r = parseArgs([], { default: { port: 3000 } });
    assert.equal(r.port, 3000);
  });

  test('default overridden by user-supplied', () => {
    const r = parseArgs(['--port=8080'], { default: { port: 3000 } });
    assert.equal(r.port, 8080);
  });
});

describe('parseArgs — coercion', () => {
  test('numbers parsed', () => {
    assert.equal(parseArgs(['--n=42']).n, 42);
    assert.equal(parseArgs(['--n=3.14']).n, 3.14);
  });
  test('true / false strings', () => {
    assert.equal(parseArgs(['--flag=true']).flag, true);
    assert.equal(parseArgs(['--flag=false']).flag, false);
  });
  test('repeated flag → array', () => {
    const r = parseArgs(['--tag=a', '--tag=b', '--tag=c']);
    assert.deepEqual(r.tag, ['a', 'b', 'c']);
  });
});

describe('parseArgs — separators', () => {
  test('-- captures passthrough when opts["--"] true', () => {
    const r = parseArgs(['cmd', '--', '--inner', 'x'], { '--': true });
    assert.deepEqual(r._, ['cmd']);
    assert.deepEqual(r['--'], ['--inner', 'x']);
  });

  test('stopEarly puts everything after first positional in _', () => {
    const r = parseArgs(['cmd', '--inner', 'x'], { stopEarly: true });
    assert.deepEqual(r._, ['cmd', '--inner', 'x']);
  });
});

describe('parseArgs — guards', () => {
  test('non-array argv throws', () => {
    assert.throws(() => parseArgs('nope'), TypeError);
  });
});
