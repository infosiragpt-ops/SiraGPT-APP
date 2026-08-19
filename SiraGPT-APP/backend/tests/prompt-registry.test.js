'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createPromptRegistry,
  hashTemplate,
  extractVars,
  parseSemver,
  compareSemver,
} = require('../src/services/agents/prompt-registry');

describe('helpers', () => {
  test('hashTemplate is deterministic', () => {
    assert.equal(hashTemplate('hi {x}'), hashTemplate('hi {x}'));
    assert.notEqual(hashTemplate('hi {x}'), hashTemplate('hi {y}'));
  });
  test('extractVars finds {var} placeholders', () => {
    const v = extractVars('hi {a} and {b}, {a} again');
    assert.deepEqual([...v].sort(), ['a', 'b']);
  });
  test('parseSemver / compareSemver', () => {
    assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3]);
    assert.ok(compareSemver('2.0.0', '1.9.9') > 0);
    assert.ok(compareSemver('1.2.3', '1.2.3') === 0);
    assert.ok(compareSemver('1.0.10', '1.0.9') > 0);
    assert.throws(() => parseSemver('bad'), TypeError);
  });
});

describe('createPromptRegistry — register', () => {
  test('happy path stores template + computes hash', () => {
    const r = createPromptRegistry();
    const e = r.register({ id: 'sys', version: '1.0.0', template: 'You are {role}.' });
    assert.equal(e.id, 'sys');
    assert.equal(e.version, '1.0.0');
    assert.equal(e.hash.length, 64);
    assert.deepEqual([...e.vars], ['role']);
  });

  test('rejects bad input', () => {
    const r = createPromptRegistry();
    assert.throws(() => r.register({}), TypeError);
    assert.throws(() => r.register({ id: '', version: '1.0.0', template: 't' }), TypeError);
    assert.throws(() => r.register({ id: 'x', version: 'bad', template: 't' }), TypeError);
    assert.throws(() => r.register({ id: 'x', version: '1.0.0', template: '' }), TypeError);
  });

  test('re-registering same version + same content is idempotent', () => {
    const r = createPromptRegistry();
    const a = r.register({ id: 'x', version: '1.0.0', template: 'hi' });
    const b = r.register({ id: 'x', version: '1.0.0', template: 'hi' });
    assert.equal(a.hash, b.hash);
  });

  test('re-registering same version with different content rejects', () => {
    const r = createPromptRegistry();
    r.register({ id: 'x', version: '1.0.0', template: 'a' });
    assert.throws(() => r.register({ id: 'x', version: '1.0.0', template: 'b' }), /different content/);
  });

  test('declared vars: undeclared placeholder rejects', () => {
    const r = createPromptRegistry();
    assert.throws(
      () => r.register({ id: 'x', version: '1.0.0', template: 'hi {a} {z}', vars: ['a'] }),
      /undeclared var/,
    );
  });

  test('declared vars accept Set or Array', () => {
    const r = createPromptRegistry();
    r.register({ id: 'a', version: '1.0.0', template: 'hi {x}', vars: new Set(['x']) });
    r.register({ id: 'b', version: '1.0.0', template: 'hi {x}', vars: ['x'] });
  });
});

describe('createPromptRegistry — versions and get', () => {
  test('versions sorted descending semver', () => {
    const r = createPromptRegistry();
    r.register({ id: 'p', version: '1.0.0', template: 'a' });
    r.register({ id: 'p', version: '1.10.0', template: 'b' });
    r.register({ id: 'p', version: '1.2.0', template: 'c' });
    assert.deepEqual(r.versions('p'), ['1.10.0', '1.2.0', '1.0.0']);
  });

  test('get without version returns latest', () => {
    const r = createPromptRegistry();
    r.register({ id: 'p', version: '1.0.0', template: 'a' });
    r.register({ id: 'p', version: '2.0.0', template: 'b' });
    assert.equal(r.get('p').version, '2.0.0');
    assert.equal(r.get('p', '1.0.0').template, 'a');
    assert.equal(r.get('p', '9.9.9'), null);
    assert.equal(r.get('missing'), null);
  });

  test('lineageFor returns id+version+hash', () => {
    const r = createPromptRegistry();
    r.register({ id: 'p', version: '1.0.0', template: 'hi' });
    const l = r.lineageFor('p');
    assert.equal(l.id, 'p');
    assert.equal(l.version, '1.0.0');
    assert.equal(l.hash, hashTemplate('hi'));
  });
});

describe('createPromptRegistry — render', () => {
  test('substitutes provided vars', () => {
    const r = createPromptRegistry();
    r.register({ id: 's', version: '1.0.0', template: 'You are {role} on {date}.' });
    const out = r.render('s', { role: 'helper', date: '2026-05-09' });
    assert.equal(out.text, 'You are helper on 2026-05-09.');
    assert.equal(out.lineage.id, 's');
  });

  test('null/undefined var → empty string', () => {
    const r = createPromptRegistry();
    r.register({ id: 's', version: '1.0.0', template: 'hi {x}!' });
    assert.equal(r.render('s', { x: null }).text, 'hi !');
    assert.equal(r.render('s', { x: undefined }).text, 'hi !');
  });

  test('missing var stays as placeholder for two-pass render', () => {
    const r = createPromptRegistry();
    r.register({ id: 's', version: '1.0.0', template: 'hi {x} {y}' });
    assert.equal(r.render('s', { x: 'a' }).text, 'hi a {y}');
  });

  test('render unknown id throws', () => {
    const r = createPromptRegistry();
    assert.throws(() => r.render('nope', {}), /unknown template/);
  });

  test('render(id, vars, {version}) selects the explicit version', () => {
    const r = createPromptRegistry();
    r.register({ id: 's', version: '1.0.0', template: 'old {x}' });
    r.register({ id: 's', version: '2.0.0', template: 'new {x}' });
    assert.equal(r.render('s', { x: 'q' }).text, 'new q');
    assert.equal(r.render('s', { x: 'q' }, { version: '1.0.0' }).text, 'old q');
  });
});

describe('createPromptRegistry — list', () => {
  test('list returns metadata for every (id, version)', () => {
    const r = createPromptRegistry();
    r.register({ id: 'a', version: '1.0.0', template: 'A' });
    r.register({ id: 'a', version: '1.1.0', template: 'A1' });
    r.register({ id: 'b', version: '1.0.0', template: 'B' });
    const meta = r.list();
    assert.equal(meta.length, 3);
    for (const row of meta) {
      assert.ok(row.hash.length === 64);
      assert.ok(Array.isArray(row.vars));
    }
  });
});
