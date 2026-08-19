/**
 * Tests for encryption.js — AES-256-CBC token encryption helpers.
 *
 * The module calls process.exit(1) at require-time if ENCRYPTION_KEY
 * is missing or the wrong length. We work around that by:
 *
 *   - Setting a valid 64-hex ENCRYPTION_KEY before require().
 *   - Validating the boot-time guard by spawning a child process with
 *     no / bad key.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, before } = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 64-hex char (32 bytes) test key. NOT a real key — used only inside
// this process to satisfy the require-time guard.
const TEST_KEY = 'a'.repeat(64);
process.env.ENCRYPTION_KEY = TEST_KEY;

// Must require AFTER setting the env var, otherwise the module's top-
// level process.exit(1) fires the second the require() is evaluated.
const encryption = require('../src/utils/encryption');

const MODULE_PATH = path.resolve(__dirname, '../src/utils/encryption.js');

describe('encrypt + decrypt roundtrip', () => {
  it('decrypt(encrypt(x)) === x for ASCII', () => {
    const text = 'hello world';
    const cipher = encryption.encrypt(text);
    assert.notEqual(cipher, text);
    assert.equal(encryption.decrypt(cipher), text);
  });

  it('handles unicode (multi-byte) correctly', () => {
    const text = 'héllo 世界 🚀';
    const cipher = encryption.encrypt(text);
    assert.equal(encryption.decrypt(cipher), text);
  });

  it('handles the empty string', () => {
    const cipher = encryption.encrypt('');
    assert.equal(encryption.decrypt(cipher), '');
  });

  it('handles long payloads (4 KB)', () => {
    const text = 'x'.repeat(4096);
    const cipher = encryption.encrypt(text);
    assert.equal(encryption.decrypt(cipher), text);
  });

  it('produces ciphertext in the documented "iv:cipher" hex format', () => {
    const cipher = encryption.encrypt('abc');
    assert.match(cipher, /^[0-9a-f]+:[0-9a-f]+$/);
    const [iv] = cipher.split(':');
    // IV is 16 bytes → 32 hex chars.
    assert.equal(iv.length, 32);
  });

  it('uses a fresh random IV per encrypt() — same plaintext yields different ciphertext', () => {
    const a = encryption.encrypt('same plaintext');
    const b = encryption.encrypt('same plaintext');
    assert.notEqual(a, b, 'IV must be randomized per call');
    // Both should still decrypt to the original.
    assert.equal(encryption.decrypt(a), 'same plaintext');
    assert.equal(encryption.decrypt(b), 'same plaintext');
  });
});

describe('decrypt — error paths', () => {
  it('throws on malformed input (no colon)', () => {
    assert.throws(() => encryption.decrypt('not-a-cipher'), /Invalid|hex/i);
  });

  it('throws when the IV portion is the wrong length', () => {
    // Build a fake "ciphertext" with a 1-byte IV — crypto will reject.
    assert.throws(() => encryption.decrypt('aa:bb'), /Invalid initialization vector|IV/i);
  });

  it('throws on tampered ciphertext (auth-tag-free CBC: bad-pad rejection)', () => {
    const cipher = encryption.encrypt('original');
    const [iv, ct] = cipher.split(':');
    // Flip the last byte of the ciphertext to corrupt the final block.
    const corrupted = ct.slice(0, -2) + (ct.slice(-2) === 'ff' ? '00' : 'ff');
    assert.throws(() => encryption.decrypt(`${iv}:${corrupted}`));
  });
});

describe('module surface', () => {
  it('exports exactly { encrypt, decrypt }', () => {
    const keys = Object.keys(encryption).sort();
    assert.deepEqual(keys, ['decrypt', 'encrypt']);
  });
});

describe('require-time guard (boot validation)', () => {
  // These run encryption.js in a child process so the module's
  // process.exit(1) doesn't kill the test runner.

  function runFreshChild(env) {
    return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(MODULE_PATH)})`], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
  }

  it('exits with code 1 when ENCRYPTION_KEY is unset', () => {
    const result = runFreshChild({ ENCRYPTION_KEY: '' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENCRYPTION_KEY not set/i);
  });

  it('exits with code 1 when ENCRYPTION_KEY is wrong length', () => {
    const result = runFreshChild({ ENCRYPTION_KEY: 'tooshort' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /64 hex characters/i);
  });

  it('boots successfully when ENCRYPTION_KEY is exactly 64 hex chars', () => {
    const result = runFreshChild({ ENCRYPTION_KEY: 'a'.repeat(64) });
    assert.equal(result.status, 0);
  });
});
