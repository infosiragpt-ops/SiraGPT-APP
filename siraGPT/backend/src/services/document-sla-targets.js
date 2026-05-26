'use strict';

/**
 * document-sla-targets.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Service Level targets (SLA / SLO / SLI) in prose:
 *
 *   - uptime: 99.9% / 99.95% / 99.99% / "three nines"
 *   - latency: p99 < 200ms / p95 < 500ms / median < 100ms
 *   - error rate: error rate < 0.1% / 1 in 10000 / 4xx ratio < 0.5%
 *   - throughput: 10k req/s / 100 rps / 1M events/day
 *   - availability windows / RPO / RTO
 *
 * Public API:
 *   extractSlaTargets(text)             → { entries, totals, total }
 *   buildSlaTargetsForFiles(files)      → { perFile, aggregate, totals }
 *   renderSlaTargetsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 14;
const MAX_AGGREGATE = 18;
const MAX_BLOCK_CHARS = 4500;

const UPTIME_RE = /\b(?:(?:availability|uptime|SLO|SLA|SLI)[\s:]+)?(\d{2,3}\.?\d{0,3})\s*%(?:\s+(?:uptime|availability))?/gi;
const NINES_RE = /\b(three|four|five|two)\s+nines?\b/gi;
const LATENCY_RE = /\bp(50|75|90|95|99|99\.9|99\.99|999)\s*(?:[<>=]+|of|under|below|at most)\s*(\d+(?:\.\d+)?)\s*(ms|s|µs|us)/gi;
const ERROR_RATE_RE = /\b(?:error\s+rate|failure\s+rate|reject\s+rate|5xx\s+ratio|4xx\s+ratio)\s*(?:[<>=]+|under|below|less\s+than|at\s+most)\s*(\d+(?:\.\d+)?)\s*%/gi;
const THROUGHPUT_RE = /\b(\d+(?:\.\d+)?)\s*(k|K|m|M|B)?\s*(?:req|requests|rps|qps|tps|ops|events|writes|reads|messages)(?:\s*\/\s*(?:s|sec|second|min|minute|hour|h|day|d))?/gi;
const RPO_RTO_RE = /\b(RPO|RTO|MTTR|MTTD)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(s|min|minute|h|hour|d|day)/gi;

function classifyUptime(value) {
  const v = parseFloat(value);
  if (v >= 99.999) return 'five-nines';
  if (v >= 99.99) return 'four-nines';
  if (v >= 99.9) return 'three-nines';
  if (v >= 99) return 'two-nines';
  if (v >= 95) return 'standard';
  return 'low';
}

function ninesValue(word) {
  switch (word.toLowerCase()) {
    case 'two': return '99';
    case 'three': return '99.9';
    case 'four': return '99.99';
    case 'five': return '99.999';
    default: return '?';
  }
}

function extractSlaTargets(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { uptime: 0, latency: 0, errorRate: 0, throughput: 0, recovery: 0 };

  function push(kind, value, normalised) {
    const key = `${kind}:${normalised}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, value, normalised });
    if (totals[kind] != null) totals[kind] += 1;
  }

  // Uptime/availability percentages
  UPTIME_RE.lastIndex = 0;
  let m;
  while ((m = UPTIME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const v = parseFloat(m[1]);
    if (v < 50 || v > 100) continue; // SLO percentages live in this range
    const bucket = classifyUptime(m[1]);
    push('uptime', `${m[1]}%`, `${m[1]}%-${bucket}`);
  }

  if (entries.length < MAX_PER_FILE) {
    NINES_RE.lastIndex = 0;
    while ((m = NINES_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('uptime', `${m[1]} nines`, ninesValue(m[1]));
    }
  }

  // Latency percentiles
  if (entries.length < MAX_PER_FILE) {
    LATENCY_RE.lastIndex = 0;
    while ((m = LATENCY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('latency', `p${m[1]} < ${m[2]}${m[3]}`, `p${m[1]}:${m[2]}${m[3]}`);
    }
  }

  // Error rate
  if (entries.length < MAX_PER_FILE) {
    ERROR_RATE_RE.lastIndex = 0;
    while ((m = ERROR_RATE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('errorRate', `error < ${m[1]}%`, `err:${m[1]}%`);
    }
  }

  // Throughput
  if (entries.length < MAX_PER_FILE) {
    THROUGHPUT_RE.lastIndex = 0;
    while ((m = THROUGHPUT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const v = parseFloat(m[1]);
      if (v < 1) continue;
      const scale = m[2] || '';
      push('throughput', m[0].slice(0, 50), `${v}${scale}:${m[0].split(/\s/).slice(-1)[0]}`);
    }
  }

  // RPO / RTO
  if (entries.length < MAX_PER_FILE) {
    RPO_RTO_RE.lastIndex = 0;
    while ((m = RPO_RTO_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('recovery', `${m[1]} ${m[2]}${m[3]}`, `${m[1]}:${m[2]}${m[3]}`);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildSlaTargetsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { uptime: 0, latency: 0, errorRate: 0, throughput: 0, recovery: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractSlaTargets(txt);
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

function renderSlaTargetsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## SLA / SLO TARGETS'];
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
  extractSlaTargets,
  buildSlaTargetsForFiles,
  renderSlaTargetsBlock,
  _internal: { classifyUptime, ninesValue },
};
