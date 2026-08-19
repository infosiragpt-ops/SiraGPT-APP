'use strict';

/**
 * document-bandwidth-units.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects bandwidth and capacity quantities — surfaces "we move 10 PB per
 * day" / "1 Gbps egress" / "5M req/s peak".
 *
 * Distinct from document-hardware-specs.js (which captures hardware
 * configuration) — this targets capacity / throughput / volume references
 * in any document.
 *
 * Targets:
 *   - bandwidth:  10 Gbps / 100 Mbps / 5 Tbps
 *   - storage:    500 GB / 10 TB / 2 PB / 100 PiB
 *   - request rate: 5k rps / 1M qps / 10K tps
 *   - throughput: 10K events/sec / 1M writes/day
 *
 * Public API:
 *   extractBandwidthUnits(text)             → { entries, totals, total }
 *   buildBandwidthUnitsForFiles(files)      → { perFile, aggregate, totals }
 *   renderBandwidthUnitsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 16;
const MAX_AGGREGATE = 22;
const MAX_BLOCK_CHARS = 4500;

const BANDWIDTH_RE = /\b(\d+(?:\.\d+)?)\s*(Kbps|Mbps|Gbps|Tbps)\b/g;
const STORAGE_LARGE_RE = /\b(\d+(?:\.\d+)?)\s*(KB|KiB|MB|MiB|GB|GiB|TB|TiB|PB|PiB|EB|EiB)\b(?!\s*(?:DDR|SSD|NVMe|HDD|disk|storage|RAM|memory))/g;
const RATE_RE = /\b(\d+(?:\.\d+)?)\s*([KMB]?)\s*(rps|qps|tps|ops|req\/s|requests\/s|events?\/s|messages\/s|writes?\/s|reads?\/s)/gi;
const VOLUME_RE = /\b(\d+(?:\.\d+)?)\s*([KMB]?)\s*(events?|requests|messages|writes|reads|rows|users|sessions)\s*(?:per|\/)\s*(s|second|min|minute|hour|h|day|d|week|w|month)\b/gi;

function normaliseScale(s) {
  if (!s) return 1;
  const c = s.toLowerCase();
  if (c === 'k') return 1e3;
  if (c === 'm') return 1e6;
  if (c === 'b') return 1e9;
  return 1;
}

function classifyMagnitude(n) {
  if (n >= 1e12) return 'trillion';
  if (n >= 1e9) return 'billion';
  if (n >= 1e6) return 'million';
  if (n >= 1e3) return 'thousand';
  return 'small';
}

function extractBandwidthUnits(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { bandwidth: 0, storage: 0, rate: 0, volume: 0 };

  function push(kind, raw, normalised) {
    const key = `${kind}:${normalised}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, value: raw, normalised });
    if (totals[kind] != null) totals[kind] += 1;
  }

  BANDWIDTH_RE.lastIndex = 0;
  let m;
  while ((m = BANDWIDTH_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('bandwidth', `${m[1]} ${m[2]}`, `${m[1]}-${m[2].toLowerCase()}`);
  }

  if (entries.length < MAX_PER_FILE) {
    STORAGE_LARGE_RE.lastIndex = 0;
    while ((m = STORAGE_LARGE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('storage', `${m[1]} ${m[2]}`, `${m[1]}-${m[2].toLowerCase()}`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    RATE_RE.lastIndex = 0;
    while ((m = RATE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const value = parseFloat(m[1]) * normaliseScale(m[2]);
      push('rate', m[0].slice(0, 40).trim(), `${m[1]}${m[2] || ''}-${m[3].toLowerCase()}`);
    }
  }

  if (entries.length < MAX_PER_FILE) {
    VOLUME_RE.lastIndex = 0;
    while ((m = VOLUME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('volume', m[0].slice(0, 60).trim(), `${m[1]}${m[2] || ''}-${m[3].toLowerCase()}-per-${m[4].toLowerCase()}`);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildBandwidthUnitsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { bandwidth: 0, storage: 0, rate: 0, volume: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractBandwidthUnits(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.normalised}`;
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

function renderBandwidthUnitsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## BANDWIDTH & VOLUME UNITS'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 8)) {
      lines.push(`- [${e.kind}] ${e.value}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractBandwidthUnits,
  buildBandwidthUnitsForFiles,
  renderBandwidthUnitsBlock,
  _internal: { normaliseScale, classifyMagnitude },
};
