'use strict';

/**
 * document-email-auth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects email authentication TXT records:
 *
 *   - SPF:    v=spf1 ip4:... include:... -all / ~all
 *   - DKIM:   v=DKIM1; k=rsa; p=<base64>
 *   - DMARC:  v=DMARC1; p=quarantine|reject|none; rua=mailto:...
 *   - BIMI:   v=BIMI1; l=<svg-url>
 *
 * DKIM public-key bodies are MASKED.
 *
 * Public API:
 *   extractEmailAuth(text)             → { entries, totals, total }
 *   buildEmailAuthForFiles(files)      → { perFile, aggregate, totals }
 *   renderEmailAuthBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 12;
const MAX_AGGREGATE = 16;
const MAX_BLOCK_CHARS = 4500;

const SPF_RE = /\bv=spf1\b([^"\n\r]{1,300})/g;
const DKIM_RE = /\bv=DKIM1\b([^"\n\r]{1,400})/g;
const DMARC_RE = /\bv=DMARC1\b([^"\n\r]{1,400})/g;
const BIMI_RE = /\bv=BIMI1\b([^"\n\r]{1,300})/g;

function parseSpf(body) {
  const policy = /-all\b/.test(body) ? 'fail' : /~all\b/.test(body) ? 'softfail' : /\?all\b/.test(body) ? 'neutral' : /\+all\b/.test(body) ? 'pass' : 'unknown';
  const mechs = body.match(/\b(ip4|ip6|a|mx|include|exists|redirect)[:=][\S]{2,80}/g) || [];
  return { policy, mechanisms: mechs.slice(0, 6).map((m) => m.slice(0, 60)) };
}

function parseDmarc(body) {
  const policyMatch = /p=(none|quarantine|reject)\b/.exec(body);
  const policy = policyMatch ? policyMatch[1] : 'unknown';
  const pct = /pct=(\d{1,3})/.exec(body);
  const ruaMatch = /rua=mailto:[^;,\s]+/.exec(body);
  return { policy, pct: pct ? pct[1] : null, hasRua: !!ruaMatch };
}

function parseDkim(body) {
  const k = /\bk=([a-z]+)/.exec(body);
  const pMatch = /\bp=([A-Za-z0-9+/=]{20,})/.exec(body);
  return {
    algorithm: k ? k[1] : null,
    hasPublicKey: !!pMatch,
    pubkeyMasked: pMatch ? `${pMatch[1].slice(0, 8)}…${pMatch[1].slice(-4)} (${pMatch[1].length} chars)` : null,
  };
}

function extractEmailAuth(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { spf: 0, dkim: 0, dmarc: 0, bimi: 0 };

  function push(kind, body, parsed) {
    const sig = body.slice(0, 60).trim();
    const key = `${kind}:${sig}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, summary: sig, parsed });
    if (totals[kind] != null) totals[kind] += 1;
  }

  SPF_RE.lastIndex = 0;
  let m;
  while ((m = SPF_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('spf', m[1], parseSpf(m[1]));
  }
  if (entries.length < MAX_PER_FILE) {
    DKIM_RE.lastIndex = 0;
    while ((m = DKIM_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('dkim', m[1], parseDkim(m[1]));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DMARC_RE.lastIndex = 0;
    while ((m = DMARC_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('dmarc', m[1], parseDmarc(m[1]));
    }
  }
  if (entries.length < MAX_PER_FILE) {
    BIMI_RE.lastIndex = 0;
    while ((m = BIMI_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('bimi', m[1], {});
    }
  }

  return { entries, totals, total: entries.length };
}

function buildEmailAuthForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { spf: 0, dkim: 0, dmarc: 0, bimi: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractEmailAuth(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.summary}`;
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

function renderEmailAuthBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## EMAIL AUTHENTICATION (SPF / DKIM / DMARC / BIMI)', '- DKIM public-key bodies masked first-8…last-4'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 6)) {
      if (e.kind === 'spf') {
        lines.push(`- SPF (${e.parsed.policy}): mechs=${(e.parsed.mechanisms || []).join(', ').slice(0, 80) || 'none'}`);
      } else if (e.kind === 'dmarc') {
        lines.push(`- DMARC p=${e.parsed.policy}${e.parsed.pct ? ` pct=${e.parsed.pct}` : ''}${e.parsed.hasRua ? ' rua' : ''}`);
      } else if (e.kind === 'dkim') {
        lines.push(`- DKIM k=${e.parsed.algorithm || '?'} pubkey=${e.parsed.pubkeyMasked || 'absent'}`);
      } else {
        lines.push(`- ${e.kind.toUpperCase()}: ${e.summary}`);
      }
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractEmailAuth,
  buildEmailAuthForFiles,
  renderEmailAuthBlock,
  _internal: { parseSpf, parseDmarc, parseDkim },
};
