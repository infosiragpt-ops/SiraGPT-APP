'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
    serialize,
    writeJsonAtomicSync,
    writeJsonAtomic,
    readJsonSafe,
} = require('../src/utils/atomic-json-write');

let DIR;
before(() => { DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-json-')); });
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ } });

function p(name) { return path.join(DIR, name + '-' + crypto.randomBytes(4).toString('hex') + '.json'); }

test('round-trips an object', () => {
    const f = p('rt');
    const data = { a: 1, b: ['x', 'y'], nested: { ok: true } };
    const n = writeJsonAtomicSync(f, data);
    assert.ok(n > 0);
    assert.deepEqual(readJsonSafe(f), data);
});

test('pretty:true matches JSON.stringify(x, null, 2) exactly', () => {
    const f = p('pretty');
    const data = { z: 1, arr: [1, 2] };
    writeJsonAtomicSync(f, data, { pretty: true });
    assert.equal(fs.readFileSync(f, 'utf8'), JSON.stringify(data, null, 2));
});

test('atomically replaces an existing file and leaves no temp files', () => {
    const f = p('replace');
    writeJsonAtomicSync(f, { v: 1 });
    writeJsonAtomicSync(f, { v: 2 });
    assert.deepEqual(readJsonSafe(f), { v: 2 });
    const leftovers = fs.readdirSync(DIR).filter(n => n.includes('.tmp'));
    assert.equal(leftovers.length, 0, `no .tmp leftovers, saw: ${leftovers.join(',')}`);
});

test('serialization failure throws and leaves target + dir untouched', () => {
    const f = p('circular');
    writeJsonAtomicSync(f, { good: true });
    const circular = {}; circular.self = circular;
    assert.throws(() => writeJsonAtomicSync(f, circular), /circular|Converting/i);
    // original content preserved, no temp file created
    assert.deepEqual(readJsonSafe(f), { good: true });
    assert.equal(fs.readdirSync(DIR).filter(n => n.includes('.tmp')).length, 0);
});

test('readJsonSafe returns fallback on missing / empty / corrupt / BOM', () => {
    assert.equal(readJsonSafe(path.join(DIR, 'nope.json')), null);
    assert.deepEqual(readJsonSafe(path.join(DIR, 'nope.json'), { d: 1 }), { d: 1 });

    const empty = p('empty'); fs.writeFileSync(empty, '   ');
    assert.equal(readJsonSafe(empty, 'fb'), 'fb');

    const corrupt = p('corrupt'); fs.writeFileSync(corrupt, '{ not json ');
    assert.equal(readJsonSafe(corrupt, 'fb'), 'fb');

    const bom = p('bom'); fs.writeFileSync(bom, '﻿' + JSON.stringify({ ok: 1 }));
    assert.deepEqual(readJsonSafe(bom), { ok: 1 });
});

test('async writeJsonAtomic round-trips', async () => {
    const f = p('async');
    await writeJsonAtomic(f, { async: true }, { pretty: 2 });
    assert.deepEqual(readJsonSafe(f), { async: true });
});

test('mode is applied on POSIX (best-effort elsewhere)', { skip: process.platform === 'win32' }, () => {
    const f = p('mode');
    writeJsonAtomicSync(f, { x: 1 }, { mode: 0o600 });
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('serialize honors pretty as boolean or integer', () => {
    assert.equal(serialize({ a: 1 }), '{"a":1}');
    assert.equal(serialize({ a: 1 }, { pretty: true }), '{\n  "a": 1\n}');
    assert.equal(serialize({ a: 1 }, { pretty: 4 }), '{\n    "a": 1\n}');
});
