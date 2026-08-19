'use strict';

/**
 * document-web-crypto.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Web Crypto API (crypto.subtle.X) usage:
 *
 *   - Operations:    encrypt / decrypt / sign / verify / digest /
 *                    generateKey / importKey / exportKey / deriveKey / deriveBits /
 *                    wrapKey / unwrapKey
 *   - Algorithms:    AES-GCM / AES-CBC / AES-CTR / AES-KW
 *                    RSA-OAEP / RSA-PSS / RSASSA-PKCS1-v1_5
 *                    ECDSA / ECDH / HKDF / PBKDF2 / HMAC
 *                    SHA-256 / SHA-384 / SHA-512 / SHA-1
 *   - Key usages:    encrypt / decrypt / sign / verify / deriveKey / deriveBits /
 *                    wrapKey / unwrapKey
 *   - Key formats:   raw / spki / pkcs8 / jwk
 *   - Curves:        P-256 / P-384 / P-521 / Ed25519 / X25519
 *
 * Public API:
 *   extractWebCrypto(text)             → { entries, totals, total }
 *   buildWebCryptoForFiles(files)      → { perFile, aggregate, totals }
 *   renderWebCryptoBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 24;
const MAX_AGGREGATE = 30;
const MAX_BLOCK_CHARS = 5000;

const SUBTLE_OP_RE = /\bcrypto\.subtle\.(encrypt|decrypt|sign|verify|digest|generateKey|importKey|exportKey|deriveKey|deriveBits|wrapKey|unwrapKey)\s*\(/g;
const ALGO_NAME_RE = /\bname\s*:\s*["'](AES-GCM|AES-CBC|AES-CTR|AES-KW|RSA-OAEP|RSA-PSS|RSASSA-PKCS1-v1_5|ECDSA|ECDH|HKDF|PBKDF2|HMAC|SHA-256|SHA-384|SHA-512|SHA-1|MD5)["']/g;
const HASH_RE = /\bhash\s*:\s*["'](SHA-256|SHA-384|SHA-512|SHA-1)["']|\bhash\s*:\s*\{\s*name\s*:\s*["'](SHA-256|SHA-384|SHA-512|SHA-1)["']/g;
const CURVE_RE = /\bnamedCurve\s*:\s*["'](P-256|P-384|P-521|Ed25519|X25519|secp256k1)["']/g;
const KEY_FORMAT_RE = /\bimportKey\s*\(\s*["'](raw|spki|pkcs8|jwk)["']|\bexportKey\s*\(\s*["'](raw|spki|pkcs8|jwk)["']/g;
const KEY_USAGE_RE = /\[\s*((?:["'](?:encrypt|decrypt|sign|verify|deriveKey|deriveBits|wrapKey|unwrapKey)["']\s*,?\s*){1,10})\]/g;
const IV_RE = /\biv\s*:\s*([a-zA-Z_][a-zA-Z0-9_]*|crypto\.getRandomValues|new\s+Uint8Array)/g;
const RANDOM_RE = /\bcrypto\.getRandomValues\s*\(|\bcrypto\.randomUUID\s*\(/g;
const NODE_CRYPTO_RE = /\brequire\s*\(\s*['"]node:crypto['"]\s*\)|from\s+['"]node:crypto['"]|require\s*\(\s*['"]crypto['"]\s*\)/g;

function isWebCryptoLike(body) {
  return /\bcrypto\.subtle\.|crypto\.getRandomValues\s*\(|crypto\.randomUUID\s*\(|AES-GCM|AES-CBC|RSA-OAEP|RSASSA-PKCS1-v1_5|ECDSA|namedCurve|PBKDF2|HKDF/.test(body);
}

function extractWebCrypto(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isWebCryptoLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    op: 0, algo: 0, hash: 0, curve: 0,
    format: 0, usage: 0, random: 0, nodeCrypto: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  SUBTLE_OP_RE.lastIndex = 0;
  let m;
  while ((m = SUBTLE_OP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('op', `crypto.subtle.${m[1]}`, null);
  }
  if (entries.length < MAX_PER_FILE) {
    ALGO_NAME_RE.lastIndex = 0;
    while ((m = ALGO_NAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('algo', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    HASH_RE.lastIndex = 0;
    while ((m = HASH_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('hash', m[1] || m[2], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CURVE_RE.lastIndex = 0;
    while ((m = CURVE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('curve', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    KEY_FORMAT_RE.lastIndex = 0;
    while ((m = KEY_FORMAT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('format', m[1] || m[2], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    KEY_USAGE_RE.lastIndex = 0;
    while ((m = KEY_USAGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      // Extract each usage from the bracketed list
      const usages = m[1].match(/(encrypt|decrypt|sign|verify|deriveKey|deriveBits|wrapKey|unwrapKey)/g) || [];
      for (const u of usages.slice(0, 4)) {
        if (entries.length >= MAX_PER_FILE) break;
        push('usage', u, null);
      }
    }
  }

  let randomCount = 0;
  RANDOM_RE.lastIndex = 0;
  while (RANDOM_RE.exec(body) && randomCount < 20) randomCount += 1;
  totals.random = randomCount;
  if (randomCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'random', name: 'crypto.getRandomValues/randomUUID', detail: `${randomCount}` });
  }

  let nodeCryptoCount = 0;
  NODE_CRYPTO_RE.lastIndex = 0;
  while (NODE_CRYPTO_RE.exec(body) && nodeCryptoCount < 10) nodeCryptoCount += 1;
  totals.nodeCrypto = nodeCryptoCount;
  if (nodeCryptoCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'nodeCrypto', name: 'node:crypto import', detail: `${nodeCryptoCount}` });
  }

  return { entries, totals, total: entries.length };
}

function buildWebCryptoForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    op: 0, algo: 0, hash: 0, curve: 0,
    format: 0, usage: 0, random: 0, nodeCrypto: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractWebCrypto(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.name}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.kind] != null) totals[e.kind] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderWebCryptoBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## WEB CRYPTO API'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      lines.push(`- [${e.kind}] \`${e.name}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractWebCrypto,
  buildWebCryptoForFiles,
  renderWebCryptoBlock,
  _internal: { isWebCryptoLike },
};
