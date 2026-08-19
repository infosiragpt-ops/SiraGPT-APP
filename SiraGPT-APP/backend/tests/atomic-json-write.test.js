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

// ---------------------------------------------------------------------------
// Hardening: failure paths must never corrupt the target or leak temp files.
// ---------------------------------------------------------------------------

function noTmpLeftovers() {
    return fs.readdirSync(DIR).filter(n => n.includes('.tmp'));
}

test('short kernel writes are retried until the full payload is on disk', () => {
    const f = p('short-write');
    // Payload comfortably larger than the 7-byte-per-call cap below.
    const data = { msg: 'x'.repeat(200), arr: [1, 2, 3, 4, 5] };
    const realWriteSync = fs.writeSync;
    fs.writeSync = (fd, buffer, offset, length, position) =>
        realWriteSync(fd, buffer, offset, Math.min(length, 7), position);
    try {
        const n = writeJsonAtomicSync(f, data);
        assert.equal(n, Buffer.byteLength(JSON.stringify(data)));
    } finally {
        fs.writeSync = realWriteSync;
    }
    // Without the write loop a single capped write would rename a 7-byte
    // truncated temp file over the target.
    assert.deepEqual(readJsonSafe(f, 'CORRUPT'), data);
    assert.equal(noTmpLeftovers().length, 0);
});

test('zero-progress write throws cleanly instead of renaming a truncated file', () => {
    const f = p('zero-write');
    writeJsonAtomicSync(f, { keep: 'me' });
    const realWriteSync = fs.writeSync;
    fs.writeSync = () => 0; // simulate a write that makes no progress
    try {
        assert.throws(
            () => writeJsonAtomicSync(f, { huge: 'payload' }),
            (err) => err.code === 'ERR_JSON_SHORT_WRITE' && /Short write/.test(err.message)
        );
    } finally {
        fs.writeSync = realWriteSync;
    }
    // Target untouched, temp cleaned up.
    assert.deepEqual(readJsonSafe(f), { keep: 'me' });
    assert.equal(noTmpLeftovers().length, 0);
});

test('I/O failure after a partial write preserves target and cleans up temp', () => {
    const f = p('partial-then-fail');
    writeJsonAtomicSync(f, { original: true });
    const realWriteSync = fs.writeSync;
    let calls = 0;
    fs.writeSync = (fd, buffer, offset, length, position) => {
        calls += 1;
        if (calls === 1) return realWriteSync(fd, buffer, offset, Math.min(length, 5), position);
        const e = new Error('EIO: i/o error, write');
        e.code = 'EIO';
        throw e;
    };
    try {
        assert.throws(() => writeJsonAtomicSync(f, { replacement: 'x'.repeat(100) }), /EIO/);
    } finally {
        fs.writeSync = realWriteSync;
    }
    assert.ok(calls >= 2, 'write loop should have retried after the short write');
    assert.deepEqual(readJsonSafe(f), { original: true });
    assert.equal(noTmpLeftovers().length, 0);
});

test('BigInt input throws a structured JsonSerializeError, target untouched', () => {
    const f = p('bigint');
    writeJsonAtomicSync(f, { safe: 1 });
    assert.throws(
        () => writeJsonAtomicSync(f, { n: 10n }),
        (err) => err.code === 'ERR_JSON_SERIALIZE'
            && err instanceof TypeError
            && err.name === 'JsonSerializeError'
            && /BigInt/i.test(err.message)
            && err.cause instanceof TypeError
    );
    assert.deepEqual(readJsonSafe(f), { safe: 1 });
    assert.equal(noTmpLeftovers().length, 0);
});

test('undefined/function roots throw ERR_JSON_SERIALIZE, not an opaque Buffer error', () => {
    const f = p('undef');
    writeJsonAtomicSync(f, { safe: 2 });
    // JSON.stringify(undefined) returns undefined WITHOUT throwing — before
    // the guard this died later in Buffer.from() with ERR_INVALID_ARG_TYPE.
    assert.throws(
        () => writeJsonAtomicSync(f, undefined),
        (err) => err.code === 'ERR_JSON_SERIALIZE' && /not JSON-serializable/.test(err.message)
    );
    assert.throws(
        () => serialize(() => {}),
        (err) => err.code === 'ERR_JSON_SERIALIZE'
    );
    assert.throws(
        () => serialize(Symbol('s')),
        (err) => err.code === 'ERR_JSON_SERIALIZE'
    );
    assert.deepEqual(readJsonSafe(f), { safe: 2 });
    assert.equal(noTmpLeftovers().length, 0);
});

test('async writeJsonAtomic rejects with structured error on circular input', async () => {
    const f = p('async-circ');
    await writeJsonAtomic(f, { intact: true });
    const circular = {}; circular.self = circular;
    await assert.rejects(
        writeJsonAtomic(f, circular),
        (err) => err.code === 'ERR_JSON_SERIALIZE' && /circular|Converting/i.test(err.message)
    );
    await assert.rejects(
        writeJsonAtomic(f, undefined),
        (err) => err.code === 'ERR_JSON_SERIALIZE'
    );
    assert.deepEqual(readJsonSafe(f), { intact: true });
    assert.equal(noTmpLeftovers().length, 0);
});
