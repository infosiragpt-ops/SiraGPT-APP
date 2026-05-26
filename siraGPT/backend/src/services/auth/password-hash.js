'use strict';

/**
 * password-hash — scrypt-based password hashing using Node's built-in
 * crypto.scrypt. Self-describing format so a future cost-bump is
 * backwards-compatible:
 *
 *   $scrypt$N=16384$r=8$p=1$<saltB64u>$<hashB64u>
 *
 * Pairs with HMAC-webhook (#48) and signed URLs (#70) — when an
 * actual user password lands on disk, scrypt is what we want, not a
 * plain HMAC. RFC 7914 chose scrypt for its memory-hard property
 * (defeats GPU attacks better than PBKDF2).
 *
 * needsRehash() lets ops bump cost parameters without invalidating
 * old credentials: verify with the embedded params, return true from
 * needsRehash, and the caller re-hashes on next successful login.
 *
 * Public API:
 *   await hash(password, { N, r, p, keylen, saltLen })
 *     → string  (encoded record)
 *
 *   await verify(password, encoded)
 *     → { ok, needsRehash }
 *
 *   parseEncoded(s) / formatEncoded(parts)
 */

const { scrypt, randomBytes, timingSafeEqual } = require('node:crypto');
const b64u = require('../../utils/base64url');

const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const DEFAULT_KEYLEN = 32;
const DEFAULT_SALT_LEN = 16;

function asyncScrypt(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, derived) => err ? reject(err) : resolve(derived));
  });
}

function parseEncoded(s) {
  if (typeof s !== 'string' || !s.startsWith('$scrypt$')) return null;
  const parts = s.split('$');
  // ['', 'scrypt', 'N=16384', 'r=8', 'p=1', salt, hash]
  if (parts.length !== 7) return null;
  const params = { N: 0, r: 0, p: 0 };
  for (const kv of [parts[2], parts[3], parts[4]]) {
    const eq = kv.indexOf('=');
    if (eq === -1) return null;
    const k = kv.slice(0, eq);
    const v = Number(kv.slice(eq + 1));
    if (!['N', 'r', 'p'].includes(k) || !Number.isInteger(v) || v <= 0) return null;
    params[k] = v;
  }
  const salt = b64u.decode(parts[5]);
  const hash = b64u.decode(parts[6]);
  return { ...params, salt, hash };
}

function formatEncoded({ N, r, p, salt, hash }) {
  return `$scrypt$N=${N}$r=${r}$p=${p}$${b64u.encode(salt)}$${b64u.encode(hash)}`;
}

async function hash(password, {
  N = DEFAULT_N,
  r = DEFAULT_R,
  p = DEFAULT_P,
  keylen = DEFAULT_KEYLEN,
  saltLen = DEFAULT_SALT_LEN,
} = {}) {
  if (typeof password !== 'string') throw new TypeError('password-hash: password string required');
  const salt = randomBytes(saltLen);
  const derived = await asyncScrypt(password, salt, keylen, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return formatEncoded({ N, r, p, salt, hash: derived });
}

async function verify(password, encoded, { defaults } = {}) {
  if (typeof password !== 'string') return { ok: false, needsRehash: false };
  const parsed = parseEncoded(encoded);
  if (!parsed) return { ok: false, needsRehash: false };
  const derived = await asyncScrypt(password, parsed.salt, parsed.hash.length, {
    N: parsed.N, r: parsed.r, p: parsed.p, maxmem: 256 * 1024 * 1024,
  });
  let ok = false;
  try {
    ok = derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
  } catch { ok = false; }
  const want = defaults || {};
  const needsRehash =
    parsed.N < (want.N || DEFAULT_N) ||
    parsed.r < (want.r || DEFAULT_R) ||
    parsed.p < (want.p || DEFAULT_P);
  return { ok, needsRehash };
}

module.exports = {
  hash,
  verify,
  parseEncoded,
  formatEncoded,
  DEFAULT_N,
  DEFAULT_R,
  DEFAULT_P,
};
