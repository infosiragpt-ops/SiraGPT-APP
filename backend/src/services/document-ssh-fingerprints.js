'use strict';

/**
 * document-ssh-fingerprints.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects SSH key fingerprints and known_hosts entries. Useful for verifying
 * "what hosts does this configuration trust?" / "what fingerprint do they
 * expect?". Fingerprints are public information but partially masked anyway
 * because they identify specific machines.
 *
 * Targets:
 *   - SHA256 fingerprint:  SHA256:base64-43-chars
 *   - MD5 fingerprint:     MD5:xx:xx:xx:…    (legacy)
 *   - known_hosts entry:   host[,host] [ssh-rsa|ssh-ed25519|ecdsa-sha2-…] base64-blob
 *   - authorized_keys:     ssh-(rsa|ed25519|ecdsa-sha2-…) base64-blob [comment]
 *
 * Public API:
 *   extractSshFingerprints(text)            → { entries, totals, total }
 *   buildSshFingerprintsForFiles(files)     → { perFile, aggregate, totals }
 *   renderSshFingerprintsBlock(report)      → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const SHA256_RE = /\bSHA256:([A-Za-z0-9+/]{43})\b/g;
const MD5_RE = /\bMD5:((?:[0-9a-f]{2}:){15}[0-9a-f]{2})\b/gi;
const PUBKEY_RE = /\b(ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521))\s+([A-Za-z0-9+/]{40,500}=*)(?:\s+([A-Za-z0-9._@-]{1,80}))?/g;
const KNOWN_HOST_RE = /^([a-z0-9.\-,]+[a-z0-9])\s+(ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp(?:256|384|521))\s+([A-Za-z0-9+/]{40,500}=*)/gim;

function maskFingerprint(fp) {
  if (typeof fp !== 'string' || fp.length < 10) return '****';
  return `${fp.slice(0, 6)}…${fp.slice(-4)}`;
}

function maskBlob(b) {
  if (typeof b !== 'string' || b.length < 12) return '****';
  return `${b.slice(0, 6)}…${b.slice(-6)} (${b.length} chars)`;
}

function extractSshFingerprints(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { sha256: 0, md5: 0, pubkey: 0, knownHost: 0 };

  function push(kind, masked, ctx) {
    const key = `${kind}:${masked}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, masked, context: ctx });
    if (totals[kind] != null) totals[kind] += 1;
  }

  SHA256_RE.lastIndex = 0;
  let m;
  while ((m = SHA256_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('sha256', `SHA256:${maskFingerprint(m[1])}`, 'fingerprint');
  }

  if (entries.length < MAX_PER_FILE) {
    MD5_RE.lastIndex = 0;
    while ((m = MD5_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('md5', `MD5:${maskFingerprint(m[1].replace(/:/g, ''))}`, 'fingerprint-legacy');
    }
  }

  if (entries.length < MAX_PER_FILE) {
    KNOWN_HOST_RE.lastIndex = 0;
    while ((m = KNOWN_HOST_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const host = m[1].split(',')[0];
      push('knownHost', `${host} ${m[2]} ${maskBlob(m[3])}`, 'known_hosts');
    }
  }

  if (entries.length < MAX_PER_FILE) {
    PUBKEY_RE.lastIndex = 0;
    while ((m = PUBKEY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const comment = m[3] ? ` ${m[3]}` : '';
      push('pubkey', `${m[1]} ${maskBlob(m[2])}${comment}`, 'authorized_keys');
    }
  }

  return { entries, totals, total: entries.length };
}

function buildSshFingerprintsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { sha256: 0, md5: 0, pubkey: 0, knownHost: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractSshFingerprints(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.masked}`;
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

function renderSshFingerprintsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## SSH KEY FINGERPRINTS', '- Fingerprint and key blobs masked first-6…last-4'];
  const t = report.totals || {};
  const parts = [];
  if (t.sha256) parts.push(`SHA256: ${t.sha256}`);
  if (t.md5) parts.push(`MD5: ${t.md5}`);
  if (t.pubkey) parts.push(`pubkey: ${t.pubkey}`);
  if (t.knownHost) parts.push(`known_hosts: ${t.knownHost}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      lines.push(`- [${e.kind}] ${e.context}: \`${e.masked}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractSshFingerprints,
  buildSshFingerprintsForFiles,
  renderSshFingerprintsBlock,
  _internal: { maskFingerprint, maskBlob },
};
