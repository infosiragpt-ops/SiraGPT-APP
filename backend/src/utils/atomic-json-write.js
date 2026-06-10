'use strict';

/**
 * atomic-json-write.js — crash-safe, TOCTOU-safe JSON file persistence.
 *
 * Plain `fs.writeFileSync(path, JSON.stringify(x))` is not durable: a crash
 * (or a concurrent writer) mid-write leaves a truncated/partial file that
 * fails to parse on next boot. This helper writes to a unique temp file in
 * the SAME directory, fsyncs it, then atomically renames it over the target
 * (rename is atomic within a filesystem on POSIX and Windows), so a reader
 * only ever sees the old or the new complete file — never a half-written one.
 *
 * Inspired by Hermes Agent's atomic_json_write hardening (MIT): guard
 * fchmod/chmod for platforms that don't support it, never leave a stray temp
 * file behind, and fail before touching the target if serialization throws.
 *
 * Exposes:
 *   writeJsonAtomicSync(filePath, data, opts) -> bytesWritten
 *   writeJsonAtomic(filePath, data, opts)     -> Promise<bytesWritten>
 *   readJsonSafe(filePath, fallback?)         -> parsed | fallback
 *   serialize(data, opts)                     -> string (exposed for tests)
 *
 * opts: { pretty?:boolean|number, mode?:number, ensureDir?:boolean, fsyncDir?:boolean }
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * Structured error for non-serializable input (circular refs, BigInt,
 * undefined/function/symbol roots). Extends TypeError so callers that
 * `catch (e) { if (e instanceof TypeError) ... }` keep working; adds a
 * stable `code` for programmatic handling and `cause` with the original.
 */
class JsonSerializeError extends TypeError {
    constructor(message, cause) {
        super(message);
        this.name = 'JsonSerializeError';
        this.code = 'ERR_JSON_SERIALIZE';
        if (cause !== undefined) this.cause = cause;
    }
}

function serialize(data, opts = {}) {
    const space = opts.pretty === true ? 2 : (Number.isInteger(opts.pretty) ? opts.pretty : 0);
    // Serialization failures (circular refs, BigInt) are surfaced as a
    // structured JsonSerializeError BEFORE any temp file is created, so the
    // target is never touched. The original message is preserved inside ours.
    let json;
    try {
        json = JSON.stringify(data, null, space);
    } catch (err) {
        const detail = err && err.message ? err.message : String(err);
        throw new JsonSerializeError(`Data is not JSON-serializable: ${detail}`, err);
    }
    // JSON.stringify returns undefined (no throw!) for undefined, functions
    // and symbols — writing that would previously die later inside
    // Buffer.from() with an opaque ERR_INVALID_ARG_TYPE. Fail cleanly here.
    if (typeof json !== 'string') {
        throw new JsonSerializeError(
            'Data is not JSON-serializable: JSON.stringify returned undefined '
            + '(root value is undefined, a function, or a symbol)'
        );
    }
    return json;
}

function _tmpPath(filePath) {
    const rand = crypto.randomBytes(6).toString('hex');
    return `${filePath}.${process.pid}.${rand}.tmp`;
}

function _stripBom(s) {
    return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** chmod that silently tolerates platforms/filesystems without mode support. */
function _safeChmodSync(target, mode) {
    if (mode == null) return;
    try { fs.chmodSync(target, mode); } catch { /* unsupported (e.g. Windows) — ignore */ }
}

/** Best-effort directory fsync so the rename itself is durable. */
function _fsyncDirSync(dir) {
    let fd;
    try {
        fd = fs.openSync(dir, 'r');
        fs.fsyncSync(fd);
    } catch {
        /* directories aren't fsyncable on all platforms (e.g. Windows) — ignore */
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
}

/**
 * Synchronously, atomically write `data` as JSON to `filePath`.
 * @returns {number} bytes written
 */
function writeJsonAtomicSync(filePath, data, opts = {}) {
    const json = serialize(data, opts); // may throw — target untouched, good
    const buf = Buffer.from(json, 'utf8');
    const dir = path.dirname(filePath);
    if (opts.ensureDir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Preserve the existing file's mode unless explicitly overridden.
    let mode = opts.mode;
    if (mode == null) {
        try { mode = fs.statSync(filePath).mode; } catch { mode = undefined; }
    }

    const tmp = _tmpPath(filePath);
    let fd;
    try {
        fd = fs.openSync(tmp, 'w');
        // write(2) may write fewer bytes than requested (signals, quotas,
        // some filesystems). A single un-checked writeSync could fsync+rename
        // a TRUNCATED temp file over the target — loop until every byte is
        // on disk, and bail out (cleanup below) on zero progress.
        let written = 0;
        while (written < buf.length) {
            const n = fs.writeSync(fd, buf, written, buf.length - written, written);
            if (!Number.isInteger(n) || n <= 0) {
                const err = new Error(
                    `Short write to temp file "${tmp}": wrote ${written}/${buf.length} bytes`
                );
                err.code = 'ERR_JSON_SHORT_WRITE';
                throw err;
            }
            written += n;
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        _safeChmodSync(tmp, mode);
        fs.renameSync(tmp, filePath); // atomic replace
    } catch (err) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
        try { fs.unlinkSync(tmp); } catch { /* may not exist — ignore */ }
        throw err;
    }
    if (opts.fsyncDir !== false) _fsyncDirSync(dir);
    return buf.length;
}

/** Async variant (same guarantees; uses an atomic rename under the hood). */
async function writeJsonAtomic(filePath, data, opts = {}) {
    const json = serialize(data, opts);
    const buf = Buffer.from(json, 'utf8');
    const dir = path.dirname(filePath);
    if (opts.ensureDir) { try { await fsp.mkdir(dir, { recursive: true }); } catch { /* exists */ } }

    let mode = opts.mode;
    if (mode == null) {
        try { mode = (await fsp.stat(filePath)).mode; } catch { mode = undefined; }
    }

    const tmp = _tmpPath(filePath);
    let handle;
    try {
        handle = await fsp.open(tmp, 'w');
        await handle.writeFile(buf);
        await handle.sync();
        await handle.close();
        handle = undefined;
        if (mode != null) { try { await fsp.chmod(tmp, mode); } catch { /* unsupported */ } }
        await fsp.rename(tmp, filePath);
    } catch (err) {
        if (handle) { try { await handle.close(); } catch { /* ignore */ } }
        try { await fsp.unlink(tmp); } catch { /* ignore */ }
        throw err;
    }
    return buf.length;
}

/**
 * Read + parse JSON, returning `fallback` (default null) on a missing file,
 * empty file, or parse error — never throws for those cases.
 */
function readJsonSafe(filePath, fallback = null) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch {
        return fallback; // ENOENT / EACCES / etc.
    }
    const text = _stripBom(raw).trim();
    if (!text) return fallback;
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

module.exports = {
    serialize,
    writeJsonAtomicSync,
    writeJsonAtomic,
    readJsonSafe,
    JsonSerializeError,
    _tmpPath,
};
