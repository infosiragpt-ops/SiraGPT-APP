'use strict';

/**
 * Authenticated envelope encryption for future Codex project-database
 * credentials.
 *
 * This module is intentionally independent from the legacy AES-CBC helper and
 * DeployEnv. It is inert until explicitly constructed by a caller, never
 * derives weak keys, and never turns corruption into an empty object.
 *
 * Envelope: v1:<keyId>:<nonce-b64url>:<authTag-b64url>:<ciphertext-b64url>
 * AAD:      codex-project-db:<databaseId>:<credentialGeneration>
 */

const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 'v1';
const RECORD_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

class DatabaseSecretVaultError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'DatabaseSecretVaultError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  const options = cause ? { cause } : undefined;
  throw new DatabaseSecretVaultError(code, message, options);
}

function assertKeyId(value) {
  const keyId = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    fail('CODEX_DB_VAULT_INVALID_KEY_ID', 'database vault key id is invalid');
  }
  return keyId;
}

function decodeStrictBase64(value) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    fail('CODEX_DB_VAULT_INVALID_KEY', 'database vault key must be exactly 32 bytes');
  }
  const decoded = Buffer.from(text, 'base64');
  if (decoded.toString('base64') !== text) {
    fail('CODEX_DB_VAULT_INVALID_KEY', 'database vault key must be exactly 32 bytes');
  }
  return decoded;
}

function decodeStrictBase64Url(value, code = 'CODEX_DB_VAULT_MALFORMED_ENVELOPE') {
  const text = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    fail(code, 'database vault envelope is malformed');
  }
  const decoded = Buffer.from(text, 'base64url');
  if (decoded.toString('base64url') !== text) {
    fail(code, 'database vault envelope is malformed');
  }
  return decoded;
}

function decodeKey(raw) {
  if (Buffer.isBuffer(raw)) {
    if (raw.length !== KEY_BYTES) {
      fail('CODEX_DB_VAULT_INVALID_KEY', 'database vault key must be exactly 32 bytes');
    }
    return Buffer.from(raw);
  }

  const value = String(raw || '').trim();
  let decoded;
  if (/^(?:hex:)?[a-fA-F0-9]{64}$/.test(value)) {
    decoded = Buffer.from(value.replace(/^hex:/, ''), 'hex');
  } else if (value.startsWith('base64:')) {
    decoded = decodeStrictBase64(value.slice('base64:'.length));
  } else if (/^[A-Za-z0-9_-]{43}$/.test(value)) {
    decoded = decodeStrictBase64Url(value, 'CODEX_DB_VAULT_INVALID_KEY');
  } else {
    fail('CODEX_DB_VAULT_INVALID_KEY', 'database vault key must be exactly 32 bytes');
  }

  if (decoded.length !== KEY_BYTES) {
    fail('CODEX_DB_VAULT_INVALID_KEY', 'database vault key must be exactly 32 bytes');
  }
  return decoded;
}

function normalizeKeys(keys) {
  const entries = keys instanceof Map
    ? Array.from(keys.entries())
    : Object.entries(keys || {});
  if (entries.length === 0) {
    fail('CODEX_DB_VAULT_KEYRING_REQUIRED', 'database vault keyring is required');
  }

  const normalized = new Map();
  for (const [rawKeyId, rawKey] of entries) {
    const keyId = assertKeyId(rawKeyId);
    if (normalized.has(keyId)) {
      fail('CODEX_DB_VAULT_DUPLICATE_KEY', 'database vault keyring contains a duplicate key id');
    }
    const key = decodeKey(rawKey);
    // Aliasing one AES key under multiple ids would let an envelope be
    // relabelled without invalidating its GCM tag, confusing rotation state.
    // Rotation keyrings must contain genuinely distinct key material.
    for (const existing of normalized.values()) {
      if (crypto.timingSafeEqual(existing, key)) {
        fail(
          'CODEX_DB_VAULT_DUPLICATE_KEY_MATERIAL',
          'database vault keyring contains duplicate key material',
        );
      }
    }
    normalized.set(keyId, key);
  }
  return normalized;
}

function buildDatabaseSecretAad({ databaseId, credentialGeneration } = {}) {
  const id = String(databaseId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    fail('CODEX_DB_VAULT_INVALID_CONTEXT', 'database vault context is invalid');
  }
  const generation = Number(credentialGeneration);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    fail('CODEX_DB_VAULT_INVALID_CONTEXT', 'database vault context is invalid');
  }
  return `codex-project-db:${id}:${generation}`;
}

function parseEnvelope(envelope) {
  if (typeof envelope !== 'string') {
    fail('CODEX_DB_VAULT_MALFORMED_ENVELOPE', 'database vault envelope is malformed');
  }
  const parts = envelope.split(':');
  if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
    fail('CODEX_DB_VAULT_MALFORMED_ENVELOPE', 'database vault envelope is malformed');
  }

  const keyId = assertKeyId(parts[1]);
  const nonce = decodeStrictBase64Url(parts[2]);
  const authTag = decodeStrictBase64Url(parts[3]);
  const ciphertext = decodeStrictBase64Url(parts[4]);
  if (nonce.length !== NONCE_BYTES || authTag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) {
    fail('CODEX_DB_VAULT_MALFORMED_ENVELOPE', 'database vault envelope is malformed');
  }
  return { keyId, nonce, authTag, ciphertext };
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail('CODEX_DB_VAULT_INVALID_RECORD', 'database vault record is invalid');
  }
  if (record.version !== RECORD_VERSION) {
    fail('CODEX_DB_VAULT_UNSUPPORTED_VERSION', 'database vault record version is unsupported');
  }
  return {
    keyId: assertKeyId(record.keyId),
    envelope: record.envelope,
    version: record.version,
  };
}

function validateRecordEnvelopeIdentity(record) {
  const normalized = normalizeRecord(record);
  const parsed = parseEnvelope(normalized.envelope);
  if (normalized.keyId !== parsed.keyId) {
    fail('CODEX_DB_VAULT_KEY_ID_MISMATCH', 'database vault record key id does not match its envelope');
  }
  return { normalized, parsed };
}

function createDatabaseSecretVault({ activeKeyId, keys } = {}) {
  const keyring = normalizeKeys(keys);
  const active = assertKeyId(activeKeyId);
  if (!keyring.has(active)) {
    fail('CODEX_DB_VAULT_ACTIVE_KEY_MISSING', 'database vault active key is missing from the keyring');
  }

  function seal(plaintext, context) {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      fail('CODEX_DB_VAULT_INVALID_PLAINTEXT', 'database vault plaintext must be a non-empty string');
    }
    const aad = Buffer.from(buildDatabaseSecretAad(context), 'utf8');
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, keyring.get(active), nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const envelope = [
      ENVELOPE_VERSION,
      active,
      nonce.toString('base64url'),
      authTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');

    return Object.freeze({ keyId: active, envelope, version: RECORD_VERSION });
  }

  function open(record, context) {
    const { parsed } = validateRecordEnvelopeIdentity(record);
    const key = keyring.get(parsed.keyId);
    if (!key) {
      fail('CODEX_DB_VAULT_UNKNOWN_KEY', 'database vault key is unavailable');
    }

    const aad = Buffer.from(buildDatabaseSecretAad(context), 'utf8');
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, parsed.nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(parsed.authTag);
      return Buffer.concat([
        decipher.update(parsed.ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch (cause) {
      fail('CODEX_DB_VAULT_AUTH_FAILED', 'database vault authentication failed', cause);
    }
  }

  function sealJson(value, context) {
    let encoded;
    try {
      encoded = JSON.stringify(value);
    } catch (_cause) {
      // JSON errors may quote attacker-controlled values. Do not retain them
      // as `cause` on an error that can cross into logs/traces.
      fail('CODEX_DB_VAULT_JSON_INVALID', 'database vault JSON value is not serializable');
    }
    if (encoded === undefined) {
      fail('CODEX_DB_VAULT_JSON_INVALID', 'database vault JSON value is not serializable');
    }
    return seal(encoded, context);
  }

  function openJson(record, context) {
    const plaintext = open(record, context);
    try {
      return JSON.parse(plaintext);
    } catch (_cause) {
      // V8 may include a plaintext excerpt in SyntaxError.message.
      fail('CODEX_DB_VAULT_JSON_INVALID', 'database vault plaintext is not valid JSON');
    }
  }

  return Object.freeze({
    activeKeyId: active,
    seal,
    open,
    sealJson,
    openJson,
    needsRotation(record) {
      return validateRecordEnvelopeIdentity(record).normalized.keyId !== active;
    },
  });
}

function loadDatabaseSecretVaultFromEnv(env = process.env) {
  const activeKeyId = String(env.CODEX_DATABASE_VAULT_ACTIVE_KEY_ID || '').trim();
  const rawKeyring = String(env.CODEX_DATABASE_VAULT_KEYS || '').trim();
  if (!activeKeyId || !rawKeyring) {
    fail('CODEX_DB_VAULT_CONFIG_REQUIRED', 'database vault configuration is required');
  }

  let keys;
  try {
    keys = JSON.parse(rawKeyring);
  } catch (_cause) {
    // A JSON.parse cause can echo key material; retain only the safe code.
    fail('CODEX_DB_VAULT_CONFIG_INVALID', 'database vault keyring JSON is invalid');
  }
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    fail('CODEX_DB_VAULT_CONFIG_INVALID', 'database vault keyring JSON is invalid');
  }
  return createDatabaseSecretVault({ activeKeyId, keys });
}

module.exports = {
  ALGORITHM,
  ENVELOPE_VERSION,
  RECORD_VERSION,
  DatabaseSecretVaultError,
  buildDatabaseSecretAad,
  createDatabaseSecretVault,
  loadDatabaseSecretVaultFromEnv,
};
