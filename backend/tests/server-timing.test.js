'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { build, parse, createServerTimer } = require('../src/utils/server-timing');

describe('build', () => {
  test('name-only entry', () => {
    assert.equal(build([{ name: 'cache' }]), 'cache');
  });
  test('name + dur', () => {
    assert.equal(build([{ name: 'db', dur: 12.34 }]), 'db;dur=12.34');
  });
  test('integer dur emitted without trailing zeros', () => {
    assert.equal(build([{ name: 'x', dur: 50 }]), 'x;dur=50');
  });
  test('strips trailing zero in decimal', () => {
    assert.equal(build([{ name: 'x', dur: 12.5 }]), 'x;dur=12.5');
    assert.equal(build([{ name: 'x', dur: 12.10 }]), 'x;dur=12.1');
  });
  test('name + dur + desc (quoted)', () => {
    assert.equal(
      build([{ name: 'auth', dur: 8, desc: 'JWT verify' }]),
      'auth;dur=8;desc="JWT verify"'
    );
  });
  test('multiple entries comma-joined', () => {
    const h = build([
      { name: 'auth', dur: 5 },
      { name: 'db', dur: 78 },
    ]);
    assert.equal(h, 'auth;dur=5, db;dur=78');
  });
  test('escapes embedded quote and backslash in desc', () => {
    const h = build([{ name: 'x', desc: 'a"b\\c' }]);
    assert.match(h, /desc="a\\"b\\\\c"/);
  });
  test('rejects invalid name', () => {
    assert.throws(() => build([{ name: 'bad name' }]), TypeError);
  });
  test('rejects non-array', () => {
    assert.throws(() => build(null), TypeError);
  });
});

describe('parse', () => {
  test('single name-only entry', () => {
    assert.deepEqual(parse('cache'), [{ name: 'cache' }]);
  });
  test('name + dur', () => {
    assert.deepEqual(parse('db;dur=12.5'), [{ name: 'db', dur: 12.5 }]);
  });
  test('name + dur + desc', () => {
    assert.deepEqual(
      parse('auth;dur=8;desc="JWT verify"'),
      [{ name: 'auth', dur: 8, desc: 'JWT verify' }]
    );
  });
  test('multiple entries', () => {
    const r = parse('auth;dur=5, db;dur=78;desc="select"');
    assert.equal(r.length, 2);
    assert.equal(r[1].desc, 'select');
  });
  test('comma inside quoted desc preserved', () => {
    const r = parse('x;desc="a, b"');
    assert.equal(r.length, 1);
    assert.equal(r[0].desc, 'a, b');
  });
  test('invalid name segment skipped', () => {
    const r = parse('bad name;dur=10, ok;dur=5');
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'ok');
  });
  test('non-string / empty → []', () => {
    assert.deepEqual(parse(''), []);
    assert.deepEqual(parse(null), []);
  });
  test('round-trip', () => {
    const h = build([
      { name: 'auth', dur: 5, desc: 'verify' },
      { name: 'db', dur: 78 },
    ]);
    const r = parse(h);
    assert.equal(r[0].name, 'auth');
    assert.equal(r[0].dur, 5);
    assert.equal(r[0].desc, 'verify');
    assert.equal(r[1].name, 'db');
    assert.equal(r[1].dur, 78);
  });
});

describe('createServerTimer', () => {
  test('mark/end records dur', () => {
    let t = 0;
    const timer = createServerTimer({ now: () => t });
    timer.mark('db');
    t = 25;
    const dur = timer.end('db');
    assert.equal(dur, 25);
    const entries = timer.entries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'db');
    assert.equal(entries[0].dur, 25);
  });

  test('end() with no mark returns undefined and records nothing', () => {
    const timer = createServerTimer({ now: () => 0 });
    assert.equal(timer.end('never-marked'), undefined);
    assert.equal(timer.entries().length, 0);
  });

  test('add() records without start/end', () => {
    const timer = createServerTimer({ now: () => 0 });
    timer.add('cache', 1.5, { desc: 'hit' });
    assert.deepEqual(timer.entries(), [{ name: 'cache', dur: 1.5, desc: 'hit' }]);
  });

  test('toHeader serializes recorded entries', () => {
    let t = 0;
    const timer = createServerTimer({ now: () => t });
    timer.mark('a'); t = 10; timer.end('a', { desc: 'auth' });
    timer.add('b', 5);
    assert.equal(timer.toHeader(), 'a;dur=10;desc="auth", b;dur=5');
  });

  test('rejects invalid mark name', () => {
    const timer = createServerTimer();
    assert.throws(() => timer.mark('bad name'), TypeError);
  });
});
