'use strict';

/**
 * pem — RFC 7468 PEM encoder/decoder for keys, certificates, CSRs.
 *
 *   -----BEGIN <LABEL>-----
 *   <base64, wrapped at 64 cols>
 *   -----END <LABEL>-----
 *
 * Used wherever the platform handles cryptographic material in
 * textual form: loading JWT signing keys from env, accepting
 * plugin-signing certs uploaded by admins, exporting generated
 * keypairs. Node's `crypto.createPublicKey({ format: 'pem' })`
 * already does the heavy lifting for *known* labels, but writing
 * our own keeps us in control of strict-mode parsing (reject
 * trailing junk, reject mismatched labels) and lets us decode
 * multi-block PEM bundles like a CA chain.
 *
 * Public API:
 *   encode({ label, body })            — body Buffer → PEM string
 *   decode(pem, opts?)                  — first/strict block
 *   decodeAll(pem)                      — array (handles bundles)
 *   isPem(text)                         — predicate
 */

const LABEL_RE = /^[A-Z0-9 ]+$/;
const BLOCK_RE = /-----BEGIN ([A-Z0-9 ]+)-----\s*([\s\S]*?)\s*-----END \1-----/g;

function encode(opts = {}) {
  const { label, body } = opts;
  if (typeof label !== 'string' || !LABEL_RE.test(label)) {
    throw new TypeError('pem: label must be uppercase letters/digits/spaces');
  }
  if (!Buffer.isBuffer(body)) {
    throw new TypeError('pem: body must be a Buffer');
  }
  const b64 = body.toString('base64');
  const wrapped = b64.match(/.{1,64}/g) || [''];
  return `-----BEGIN ${label}-----\n${wrapped.join('\n')}\n-----END ${label}-----\n`;
}

function decodeAll(pem) {
  if (typeof pem !== 'string' || pem.length === 0) return [];
  const out = [];
  let m;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(pem)) !== null) {
    const label = m[1];
    const b64 = m[2].replace(/\s+/g, '');
    let body;
    try {
      body = Buffer.from(b64, 'base64');
    } catch {
      continue;
    }
    // Validate: base64 round-trip must match (rejects garbage chars).
    if (body.toString('base64').replace(/=+$/, '') !== b64.replace(/=+$/, '')) continue;
    out.push({ label, body });
  }
  return out;
}

function decode(pem, opts = {}) {
  const blocks = decodeAll(pem);
  if (blocks.length === 0) {
    throw new TypeError('pem: no valid PEM block found');
  }
  if (opts.expectedLabel && blocks[0].label !== opts.expectedLabel) {
    throw new TypeError(
      `pem: expected label "${opts.expectedLabel}", got "${blocks[0].label}"`
    );
  }
  if (opts.strict && blocks.length > 1) {
    throw new TypeError(`pem: strict mode rejected multi-block PEM (got ${blocks.length} blocks)`);
  }
  return blocks[0];
}

function isPem(text) {
  if (typeof text !== 'string') return false;
  BLOCK_RE.lastIndex = 0;
  return BLOCK_RE.test(text);
}

module.exports = {
  encode,
  decode,
  decodeAll,
  isPem,
};
