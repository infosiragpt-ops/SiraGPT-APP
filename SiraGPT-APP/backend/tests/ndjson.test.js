'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createNdjsonParser,
  serializeNdjson,
  stringifyOne,
} = require('../src/utils/ndjson');

function collect() {
  const out = [];
  const errs = [];
  const p = createNdjsonParser({
    onLine: (v) => out.push(v),
    onError: (e, line) => errs.push({ msg: e.message, line }),
  });
  return { p, out, errs };
}

describe('createNdjsonParser — basic', () => {
  test('parses one complete line', () => {
    const { p, out } = collect();
    p.push('{"a":1}\n');
    assert.deepEqual(out, [{ a: 1 }]);
  });

  test('parses multiple lines in one chunk', () => {
    const { p, out } = collect();
    p.push('{"a":1}\n{"b":2}\n{"c":3}\n');
    assert.deepEqual(out, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test('handles \\r\\n line endings', () => {
    const { p, out } = collect();
    p.push('{"a":1}\r\n{"b":2}\r\n');
    assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
  });

  test('skips blank lines', () => {
    const { p, out } = collect();
    p.push('{"a":1}\n\n\n{"b":2}\n');
    assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
  });

  test('split chunks reassemble correctly', () => {
    const { p, out } = collect();
    p.push('{"hel');
    p.push('lo":1}');
    p.push('\n');
    assert.deepEqual(out, [{ hello: 1 }]);
  });

  test('end() flushes trailing partial line as a full record', () => {
    const { p, out } = collect();
    p.push('{"x":42}');
    p.end();
    assert.deepEqual(out, [{ x: 42 }]);
  });
});

describe('createNdjsonParser — error handling', () => {
  test('malformed line surfaces via onError but parsing continues', () => {
    const { p, out, errs } = collect();
    p.push('{"a":1}\nNOT JSON\n{"b":2}\n');
    assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].line, 'NOT JSON');
  });

  test('throwing onLine reported via onError, parser keeps going', () => {
    const errs = [];
    let count = 0;
    const p = createNdjsonParser({
      onLine: (v) => {
        count += 1;
        if (v.bad) throw new Error('boom');
      },
      onError: (e) => errs.push(e.message),
    });
    p.push('{"ok":1}\n{"bad":1}\n{"ok":2}\n');
    assert.equal(count, 3);
    assert.deepEqual(errs, ['boom']);
  });

  test('throwing onError swallowed', () => {
    const p = createNdjsonParser({
      onLine: () => {},
      onError: () => { throw new Error('sink bad'); },
    });
    p.push('not json\n'); // would trigger onError
    // must not throw
  });
});

describe('createNdjsonParser — snapshot', () => {
  test('counts lines, errors, and pending buffer', () => {
    const { p } = collect();
    p.push('{"a":1}\n{"b":2}\nbad\n{"c":');
    const s = p.snapshot();
    assert.equal(s.lines, 2);
    assert.equal(s.errors, 1);
    assert.ok(s.partialBufferLen > 0);
  });
});

describe('serializeNdjson / stringifyOne', () => {
  test('round-trips through parser', () => {
    const values = [{ a: 1 }, { b: 'x' }, { c: [1, 2] }];
    const text = serializeNdjson(values);
    const { p, out } = collect();
    p.push(text);
    assert.deepEqual(out, values);
  });

  test('empty array → empty string', () => {
    assert.equal(serializeNdjson([]), '');
  });

  test('non-array throws', () => {
    assert.throws(() => serializeNdjson('nope'), TypeError);
  });

  test('stringifyOne adds a trailing newline', () => {
    assert.equal(stringifyOne({ x: 1 }), '{"x":1}\n');
  });
});

describe('createNdjsonParser — Buffer + Uint8Array', () => {
  test('Buffer chunk decoded as utf8', () => {
    const { p, out } = collect();
    p.push(Buffer.from('{"a":1}\n', 'utf8'));
    assert.deepEqual(out, [{ a: 1 }]);
  });

  test('Uint8Array chunk decoded as utf8', () => {
    const { p, out } = collect();
    p.push(new Uint8Array(Buffer.from('{"x":2}\n')));
    assert.deepEqual(out, [{ x: 2 }]);
  });
});
