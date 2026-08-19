'use strict';

/**
 * hosting/credentials — seal/open SFTP/FTP credentials at rest.
 *
 * Reuses the project's AES-256 `utils/encryption`. The encrypt/decrypt
 * functions are injectable (DIP) so tests run without ENCRYPTION_KEY — the
 * real module is required lazily on first use only.
 */

let _enc = null;
let _dec = null;
function lazyEncrypt(text) {
  if (!_enc) _enc = require('../../utils/encryption').encrypt;
  return _enc(text);
}
function lazyDecrypt(blob) {
  if (!_dec) _dec = require('../../utils/encryption').decrypt;
  return _dec(blob);
}

/**
 * Seal a credential bundle to an opaque string for DB storage.
 * @param {{password?:string, privateKey?:string, passphrase?:string}} creds
 */
function sealCreds(creds, encrypt = lazyEncrypt) {
  const clean = {
    password: creds && creds.password ? String(creds.password) : undefined,
    privateKey: creds && creds.privateKey ? String(creds.privateKey) : undefined,
    passphrase: creds && creds.passphrase ? String(creds.passphrase) : undefined,
  };
  return encrypt(JSON.stringify(clean));
}

/** Open a sealed blob back to the credential bundle, or null if unreadable. */
function openCreds(blob, decrypt = lazyDecrypt) {
  if (!blob) return null;
  try {
    return JSON.parse(decrypt(blob));
  } catch {
    return null;
  }
}

/** Public view of what kind of secret is stored (never the secret itself). */
function credsSummary(blob, decrypt = lazyDecrypt) {
  const c = openCreds(blob, decrypt);
  if (!c) return { hasCreds: false };
  return {
    hasCreds: Boolean(c.password || c.privateKey),
    kind: c.privateKey ? 'key' : c.password ? 'password' : 'none',
  };
}

/** Seal/open a generic JSON object (used for build env vars / secrets). */
function sealJson(obj, encrypt = lazyEncrypt) {
  return encrypt(JSON.stringify(obj || {}));
}
function openJson(blob, decrypt = lazyDecrypt) {
  if (!blob) return {};
  try {
    const v = JSON.parse(decrypt(blob));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

module.exports = { sealCreds, openCreds, credsSummary, sealJson, openJson };
