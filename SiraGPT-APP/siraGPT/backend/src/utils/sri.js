'use strict';

/**
 * sri — Subresource Integrity (W3C SRI) hash builder + verifier.
 *
 * SRI strings look like `sha384-<base64-digest>` and were originally
 * specified for `<script integrity="...">` to let browsers reject
 * tampered CDN payloads. The same metadata format is the cleanest
 * way for *us* to pin plugin/skill artifacts: ship the SRI string
 * with the manifest, then refuse to load a downloaded blob whose
 * hash doesn't match. No server roundtrip, no key rotation.
 *
 * Spec format (one or more space-separated tokens, strongest wins):
 *   sha256-<b64>  |  sha384-<b64>  |  sha512-<b64>  [?<options>]
 *
 * Public API:
 *   build(buffer, { algorithm = 'sha384' })  → SRI token
 *   parse(metadata)                          → array of { algorithm, hash }
 *   verify(buffer, metadata)                 → boolean (any token matches)
 *   strongest(metadata)                      → best { algorithm, hash } | null
 */

const { createHash, timingSafeEqual } = require('node:crypto');

const ALG_PRIORITY = { sha256: 1, sha384: 2, sha512: 3 };
const VALID_ALGS = new Set(Object.keys(ALG_PRIORITY));

function digest(algorithm, buffer) {
  return createHash(algorithm).update(buffer).digest();
}

function build(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer) && typeof buffer !== 'string') {
    throw new TypeError('sri: buffer must be Buffer or string');
  }
  const algorithm = (opts.algorithm || 'sha384').toLowerCase();
  if (!VALID_ALGS.has(algorithm)) {
    throw new TypeError(`sri: unsupported algorithm "${algorithm}"`);
  }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, 'utf8');
  return `${algorithm}-${digest(algorithm, buf).toString('base64')}`;
}

function parse(metadata) {
  if (typeof metadata !== 'string' || metadata.length === 0) return [];
  const out = [];
  for (const raw of metadata.split(/\s+/)) {
    if (!raw) continue;
    // Strip "?option" suffix per spec (we don't act on options).
    const token = raw.split('?')[0];
    const dash = token.indexOf('-');
    if (dash === -1) continue;
    const algorithm = token.slice(0, dash).toLowerCase();
    const hash = token.slice(dash + 1);
    if (!VALID_ALGS.has(algorithm)) continue;
    if (hash.length === 0) continue;
    out.push({ algorithm, hash });
  }
  return out;
}

function safeEqualB64(aB64, bBuf) {
  let aBuf;
  try {
    aBuf = Buffer.from(aB64, 'base64');
  } catch {
    return false;
  }
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function verify(buffer, metadata) {
  const tokens = parse(metadata);
  if (tokens.length === 0) return false;
  if (!Buffer.isBuffer(buffer) && typeof buffer !== 'string') return false;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, 'utf8');
  // Per spec: any matching token validates the resource.
  // We compute each algorithm at most once.
  const cache = new Map();
  for (const { algorithm, hash } of tokens) {
    let dig = cache.get(algorithm);
    if (!dig) { dig = digest(algorithm, buf); cache.set(algorithm, dig); }
    if (safeEqualB64(hash, dig)) return true;
  }
  return false;
}

function strongest(metadata) {
  const tokens = parse(metadata);
  if (tokens.length === 0) return null;
  let best = tokens[0];
  for (let i = 1; i < tokens.length; i++) {
    if (ALG_PRIORITY[tokens[i].algorithm] > ALG_PRIORITY[best.algorithm]) {
      best = tokens[i];
    }
  }
  return best;
}

module.exports = {
  build,
  parse,
  verify,
  strongest,
  VALID_ALGS,
};
