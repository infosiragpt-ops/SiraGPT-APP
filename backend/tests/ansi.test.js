'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { stripAnsi, hasAnsi, color, isColorEnabled, COLOR_CODES } = require('../src/utils/ansi');

const ESC = '';

describe('stripAnsi', () => {
  test('removes SGR color codes', () => {
    const colored = `${ESC}[31mred${ESC}[0m`;
    assert.equal(stripAnsi(colored), 'red');
  });

  test('removes bold + reset', () => {
    assert.equal(stripAnsi(`${ESC}[1mbold${ESC}[22m`), 'bold');
  });

  test('plain text passes through unchanged', () => {
    assert.equal(stripAnsi('no escapes here'), 'no escapes here');
  });

  test('null / non-string → empty string', () => {
    assert.equal(stripAnsi(null), '');
    assert.equal(stripAnsi(42), '');
  });

  test('mixed text + escape preserves visible chars only', () => {
    const s = `before ${ESC}[33myellow${ESC}[0m after`;
    assert.equal(stripAnsi(s), 'before yellow after');
  });

});

describe('hasAnsi', () => {
  test('detects escape codes', () => {
    assert.equal(hasAnsi(`${ESC}[31mhi${ESC}[0m`), true);
    assert.equal(hasAnsi('plain'), false);
  });

  test('non-string → false', () => {
    assert.equal(hasAnsi(null), false);
    assert.equal(hasAnsi(42), false);
  });
});

describe('color', () => {
  test('respects NO_COLOR=1 (no ANSI in output)', () => {
    const orig = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const out = color('hello', 'red');
      assert.equal(out, 'hello');
      assert.equal(hasAnsi(out), false);
    } finally {
      if (orig === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = orig;
    }
  });

  test('FORCE_COLOR=1 enables even when no TTY', () => {
    const origNo = process.env.NO_COLOR;
    const origForce = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    try {
      const out = color('hello', 'red');
      assert.match(out, /\[31m/);
      assert.match(out, /\[0m$/);
    } finally {
      if (origNo !== undefined) process.env.NO_COLOR = origNo;
      if (origForce === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = origForce;
    }
  });

  test('unknown color name passes text through', () => {
    assert.equal(color('hello', 'banana'), 'hello');
  });
});

describe('isColorEnabled', () => {
  test('NO_COLOR forces off', () => {
    assert.equal(isColorEnabled({ NO_COLOR: '1' }), false);
  });
  test('FORCE_COLOR forces on (without TTY)', () => {
    assert.equal(isColorEnabled({ FORCE_COLOR: '1' }), true);
  });
});

describe('COLOR_CODES export', () => {
  test('has reset + standard colors', () => {
    for (const k of ['reset', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'gray', 'bold', 'dim']) {
      assert.ok(typeof COLOR_CODES[k] === 'string' && COLOR_CODES[k].length > 0);
    }
  });
});
