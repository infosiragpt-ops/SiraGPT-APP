'use strict';

/**
 * document-crypto-wallets.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects cryptocurrency wallet addresses. Addresses are MASKED first-6…last-4
 * because they identify individuals' on-chain activity.
 *
 * Targets:
 *   - BTC (P2PKH):    1 + 25-34 base58
 *   - BTC (P2SH):     3 + 25-34 base58
 *   - BTC (Bech32):   bc1 + 39-59 lowercase alnum
 *   - ETH:            0x + 40 hex
 *   - SOL:            32-44 base58
 *   - ENS:            *.eth domain
 *   - TRON:           T + 33 alphanumeric
 *
 * Public API:
 *   extractCryptoWallets(text)             → { entries, totals, total }
 *   buildCryptoWalletsForFiles(files)      → { perFile, aggregate, totals }
 *   renderCryptoWalletsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const BTC_P2PKH_RE = /\b(1[1-9A-HJ-NP-Za-km-z]{24,33})\b/g;
const BTC_P2SH_RE = /\b(3[1-9A-HJ-NP-Za-km-z]{24,33})\b/g;
const BTC_BECH32_RE = /\b(bc1[02-9ac-hj-np-z]{39,58})\b/g;
const ETH_RE = /\b(0x[a-fA-F0-9]{40})\b/g;
const SOL_RE = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;
const ENS_RE = /\b([a-z0-9]{3,30}\.eth)\b/gi;
const TRON_RE = /\b(T[1-9A-HJ-NP-Za-km-z]{33})\b/g;

function maskAddress(a) {
  if (typeof a !== 'string' || a.length < 12) return '****';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function extractCryptoWallets(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { btc: 0, eth: 0, sol: 0, ens: 0, tron: 0 };

  function push(chain, raw) {
    const masked = maskAddress(raw);
    const key = `${chain}:${raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ chain, masked });
    if (totals[chain] != null) totals[chain] += 1;
  }

  // ETH first (very specific 0x prefix)
  ETH_RE.lastIndex = 0;
  let m;
  while ((m = ETH_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('eth', m[1]);
  }

  // BTC variants
  if (entries.length < MAX_PER_FILE) {
    BTC_BECH32_RE.lastIndex = 0;
    while ((m = BTC_BECH32_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('btc', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    BTC_P2PKH_RE.lastIndex = 0;
    while ((m = BTC_P2PKH_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('btc', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    BTC_P2SH_RE.lastIndex = 0;
    while ((m = BTC_P2SH_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('btc', m[1]);
    }
  }

  // TRON (T prefix)
  if (entries.length < MAX_PER_FILE) {
    TRON_RE.lastIndex = 0;
    while ((m = TRON_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('tron', m[1]);
    }
  }

  // ENS
  if (entries.length < MAX_PER_FILE) {
    ENS_RE.lastIndex = 0;
    while ((m = ENS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('ens', m[1]);
    }
  }

  // SOL last (overlaps with BTC bech32; only count if not already)
  if (entries.length < MAX_PER_FILE) {
    SOL_RE.lastIndex = 0;
    while ((m = SOL_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const raw = m[1];
      // Avoid double-count when already matched as BTC P2PKH/P2SH
      if (seen.has(`btc:${raw}`)) continue;
      push('sol', raw);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildCryptoWalletsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { btc: 0, eth: 0, sol: 0, ens: 0, tron: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractCryptoWallets(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.chain}:${e.masked}`;
      if (aggSeen.has(key)) continue;
      aggSeen.add(key);
      aggregate.push(e);
      if (totals[e.chain] != null) totals[e.chain] += 1;
      if (aggregate.length >= MAX_AGGREGATE) break;
    }
    if (aggregate.length >= MAX_AGGREGATE) break;
  }
  return { perFile, aggregate, totals };
}

function renderCryptoWalletsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## CRYPTO WALLET ADDRESSES', '- Addresses masked first-6…last-4'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      lines.push(`- ${e.chain}: \`${e.masked}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractCryptoWallets,
  buildCryptoWalletsForFiles,
  renderCryptoWalletsBlock,
  _internal: { maskAddress },
};
