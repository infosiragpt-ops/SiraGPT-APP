'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  DatabaseSecretVaultError,
  buildDatabaseSecretAad,
  createDatabaseSecretVault,
  loadDatabaseSecretVaultFromEnv,
} = require('../src/services/security/database-secret-vault');

const KEY_ONE = Buffer.alloc(32, 0x11);
const KEY_TWO = Buffer.alloc(32, 0x22);
const CONTEXT = Object.freeze({ databaseId: 'cm_db_123', credentialGeneration: 7 });

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof DatabaseSecretVaultError);
    assert.equal(error.code, code);
    return true;
  };
}

function tamperCiphertext(envelope) {
  const parts = envelope.split(':');
  const ciphertext = Buffer.from(parts[4], 'base64url');
  ciphertext[0] ^= 0x01;
  parts[4] = ciphertext.toString('base64url');
  return parts.join(':');
}

describe('Codex project database secret vault', () => {
  test('seals with AES-256-GCM and opens only with matching AAD', () => {
    const vault = createDatabaseSecretVault({ activeKeyId: 'key-1', keys: { 'key-1': KEY_ONE } });
    const plaintext = 'postgresql://runtime:plain-secret@project-db.internal/app';
    const record = vault.seal(plaintext, CONTEXT);

    assert.deepEqual(Object.keys(record).sort(), ['envelope', 'keyId', 'version']);
    assert.equal(record.keyId, 'key-1');
    assert.equal(record.version, 1);
    assert.match(record.envelope, /^v1:key-1:/);
    assert.doesNotMatch(record.envelope, /runtime|plain-secret|project-db|postgres/);
    assert.equal(vault.open(record, CONTEXT), plaintext);
    assert.throws(
      () => vault.open(record, { ...CONTEXT, databaseId: 'cm_db_other' }),
      expectCode('CODEX_DB_VAULT_AUTH_FAILED'),
    );
    assert.throws(
      () => vault.open(record, { ...CONTEXT, credentialGeneration: 8 }),
      expectCode('CODEX_DB_VAULT_AUTH_FAILED'),
    );
  });

  test('uses a fresh nonce and rejects ciphertext/auth-tag tampering', () => {
    const vault = createDatabaseSecretVault({ activeKeyId: 'key-1', keys: { 'key-1': KEY_ONE } });
    const first = vault.seal('same plaintext', CONTEXT);
    const second = vault.seal('same plaintext', CONTEXT);
    assert.notEqual(first.envelope, second.envelope);

    const tampered = { ...first, envelope: tamperCiphertext(first.envelope) };
    assert.throws(() => vault.open(tampered, CONTEXT), expectCode('CODEX_DB_VAULT_AUTH_FAILED'));
  });

  test('fails closed for malformed records, key-id substitution and unknown keys', () => {
    const vault = createDatabaseSecretVault({ activeKeyId: 'key-1', keys: { 'key-1': KEY_ONE } });
    const record = vault.seal('secret-value', CONTEXT);

    assert.throws(
      () => vault.open({ ...record, keyId: 'key-2' }, CONTEXT),
      expectCode('CODEX_DB_VAULT_KEY_ID_MISMATCH'),
    );
    assert.throws(
      () => vault.open({ ...record, version: 2 }, CONTEXT),
      expectCode('CODEX_DB_VAULT_UNSUPPORTED_VERSION'),
    );
    assert.throws(
      () => vault.open({ ...record, envelope: 'v1:key-1:not-valid' }, CONTEXT),
      expectCode('CODEX_DB_VAULT_MALFORMED_ENVELOPE'),
    );
    assert.throws(
      () => vault.needsRotation({ ...record, envelope: 'v1:key-1:not-valid' }),
      expectCode('CODEX_DB_VAULT_MALFORMED_ENVELOPE'),
    );

    const withoutOldKey = createDatabaseSecretVault({ activeKeyId: 'key-2', keys: { 'key-2': KEY_TWO } });
    assert.throws(() => withoutOldKey.open(record, CONTEXT), expectCode('CODEX_DB_VAULT_UNKNOWN_KEY'));
  });

  test('supports rotation: old keys decrypt, new seals use only the active key', () => {
    const oldVault = createDatabaseSecretVault({ activeKeyId: 'key-1', keys: { 'key-1': KEY_ONE } });
    const oldRecord = oldVault.sealJson({ DATABASE_URL: 'postgres://old-secret' }, CONTEXT);

    const rotated = createDatabaseSecretVault({
      activeKeyId: 'key-2',
      keys: { 'key-1': KEY_ONE, 'key-2': KEY_TWO },
    });
    assert.deepEqual(rotated.openJson(oldRecord, CONTEXT), { DATABASE_URL: 'postgres://old-secret' });
    assert.equal(rotated.needsRotation(oldRecord), true);

    const newRecord = rotated.sealJson({ DATABASE_URL: 'postgres://new-secret' }, {
      ...CONTEXT,
      credentialGeneration: 8,
    });
    assert.equal(newRecord.keyId, 'key-2');
    assert.equal(rotated.needsRotation(newRecord), false);
    assert.doesNotMatch(newRecord.envelope, /new-secret|DATABASE_URL/);
  });

  test('JSON corruption throws instead of returning a permissive empty object', () => {
    const vault = createDatabaseSecretVault({ activeKeyId: 'key-1', keys: { 'key-1': KEY_ONE } });
    const plaintext = 'definitely not JSON with plaintext-secret';
    const nonJson = vault.seal(plaintext, CONTEXT);
    assert.throws(
      () => vault.openJson(nonJson, CONTEXT),
      (error) => {
        assert.equal(expectCode('CODEX_DB_VAULT_JSON_INVALID')(error), true);
        assert.doesNotMatch(`${error.message}\n${error.stack}\n${error.cause || ''}`, /plaintext-secret/);
        return true;
      },
    );
  });

  test('loads a strict keyring from env and rejects missing or weak configuration', () => {
    const vault = loadDatabaseSecretVaultFromEnv({
      CODEX_DATABASE_VAULT_ACTIVE_KEY_ID: 'active-2026',
      CODEX_DATABASE_VAULT_KEYS: JSON.stringify({ 'active-2026': KEY_ONE.toString('hex') }),
    });
    const record = vault.seal('secret', CONTEXT);
    assert.equal(vault.open(record, CONTEXT), 'secret');

    assert.throws(() => loadDatabaseSecretVaultFromEnv({}), expectCode('CODEX_DB_VAULT_CONFIG_REQUIRED'));
    assert.throws(
      () => loadDatabaseSecretVaultFromEnv({
        CODEX_DATABASE_VAULT_ACTIVE_KEY_ID: 'active',
        CODEX_DATABASE_VAULT_KEYS: '{broken-vault-secret',
      }),
      (error) => {
        assert.equal(expectCode('CODEX_DB_VAULT_CONFIG_INVALID')(error), true);
        assert.doesNotMatch(`${error.message}\n${error.stack}\n${error.cause || ''}`, /broken-vault-secret/);
        return true;
      },
    );
    assert.throws(
      () => createDatabaseSecretVault({ activeKeyId: 'weak', keys: { weak: 'password' } }),
      expectCode('CODEX_DB_VAULT_INVALID_KEY'),
    );
    assert.throws(
      () => createDatabaseSecretVault({
        activeKeyId: 'alias-1',
        keys: { 'alias-1': KEY_ONE, 'alias-2': Buffer.from(KEY_ONE) },
      }),
      expectCode('CODEX_DB_VAULT_DUPLICATE_KEY_MATERIAL'),
    );
  });

  test('AAD is stable and context validation is strict', () => {
    assert.equal(buildDatabaseSecretAad(CONTEXT), 'codex-project-db:cm_db_123:7');
    assert.throws(
      () => buildDatabaseSecretAad({ databaseId: '../escape', credentialGeneration: 1 }),
      expectCode('CODEX_DB_VAULT_INVALID_CONTEXT'),
    );
    assert.throws(
      () => buildDatabaseSecretAad({ databaseId: 'db', credentialGeneration: 0 }),
      expectCode('CODEX_DB_VAULT_INVALID_CONTEXT'),
    );
  });
});
