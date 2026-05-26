'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const p = require('../src/services/attribution-persistence');

let tempDir;

describe('attribution-persistence', () => {
  beforeEach(() => {
    p._reset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-persist-'));
    p._setDirForTests(tempDir);
  });

  test('load returns null for missing key', () => {
    assert.equal(p.load('ns', 'k'), null);
  });

  test('scheduleSave + flushAll persists, load reads back', () => {
    p.scheduleSave('entities', 'user_chat_1', { foo: 'bar', n: 42 });
    p.flushAll();
    const reloaded = JSON.parse(fs.readFileSync(path.join(tempDir, 'entities__user_chat_1.json'), 'utf8'));
    assert.deepEqual(reloaded, { foo: 'bar', n: 42 });
    // cache-hit path
    const cached = p.load('entities', 'user_chat_1');
    assert.deepEqual(cached, { foo: 'bar', n: 42 });
  });

  test('remove deletes file and clears cache', () => {
    p.scheduleSave('entities', 'k', { a: 1 });
    p.flushAll();
    p.remove('entities', 'k');
    assert.equal(p.load('entities', 'k'), null);
  });

  test('listKeys returns saved keys for a namespace', () => {
    p.scheduleSave('drift', 'u1_c1', { v: 1 });
    p.scheduleSave('drift', 'u2_c2', { v: 2 });
    p.scheduleSave('metrics', 'global', { v: 3 });
    p.flushAll();
    const keys = p.listKeys('drift').sort();
    assert.deepEqual(keys, ['u1_c1', 'u2_c2']);
  });

  test('corrupt file is treated as missing', () => {
    fs.writeFileSync(path.join(tempDir, 'ns__bad.json'), '{not json');
    assert.equal(p.load('ns', 'bad'), null);
  });

  test('namespace and key sanitization prevents traversal', () => {
    // The unsanitized key would write outside the dir, but safeKey strips
    // path separators.
    p.scheduleSave('entities', '../../etc/passwd', { v: 'no' });
    p.flushAll();
    const expectedFile = path.join(tempDir, 'entities________etc_passwd.json');
    assert.ok(fs.existsSync(expectedFile));
  });

  test('getDir returns the active directory', () => {
    assert.equal(p.getDir(), tempDir);
  });

  test('debounced writes coalesce within window', () => {
    p.scheduleSave('ns', 'k', { v: 1 });
    p.scheduleSave('ns', 'k', { v: 2 });
    p.scheduleSave('ns', 'k', { v: 3 });
    p.flushAll();
    const reloaded = JSON.parse(fs.readFileSync(path.join(tempDir, 'ns__k.json'), 'utf8'));
    assert.equal(reloaded.v, 3);
  });
});
