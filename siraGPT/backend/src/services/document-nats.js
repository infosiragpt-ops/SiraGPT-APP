'use strict';

/**
 * document-nats.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects NATS / JetStream messaging system constructs:
 *
 *   - Subjects:     foo.bar.baz / orders.* / events.> (wildcards)
 *   - Methods:      nc.publish / nc.subscribe / nc.request / nc.flush
 *                   jsm.streams.add / jsm.consumers / js.publish / js.consume
 *   - Streams:      streamName "ORDERS" / "EVENTS"
 *   - Consumers:    durable name / deliver_policy / ack_policy
 *   - Headers:      Nats-Msg-Id, Nats-Expected-Stream
 *
 * Public API:
 *   extractNats(text)             → { entries, totals, total }
 *   buildNatsForFiles(files)      → { perFile, aggregate, totals }
 *   renderNatsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 22;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const METHOD_RE = /\b(?:nc|nats|client|conn)\.(publish|subscribe|request|unsubscribe|flush|drain|close|isClosed|getServer|jetstream|jetstreamManager)\s*\(/g;
const JS_METHOD_RE = /\b(?:js|jsm)\.(publish|consume|pullSubscribe|subscribe|streams|consumers|kv|objectStore|info|pull|fetch|next)\s*[.(]/g;
const SUBJECT_RE = /["']([a-zA-Z][a-zA-Z0-9_-]{0,40}(?:\.[a-zA-Z0-9_*>-]{1,40}){1,8})["']/g;
const STREAM_NAME_RE = /\b(?:name|stream)\s*:\s*["']([A-Z][A-Z0-9_]{1,40})["']/g;
const DURABLE_RE = /\bdurable(?:_name)?\s*:\s*["']([a-zA-Z][a-zA-Z0-9_-]{1,60})["']/g;
const POLICY_RE = /\b(deliver_policy|ack_policy|replay_policy|retention)\s*:\s*["']?(all|new|last|by_start_sequence|by_start_time|explicit|none|instant|original|limits|interest|workqueue)["']?/g;
const NATS_HEADER_RE = /\b(Nats-Msg-Id|Nats-Expected-Stream|Nats-Expected-Last-Sequence|Nats-Expected-Last-Subject-Sequence|Nats-Expected-Last-Msg-Id|Nats-Rollup|Nats-Sequence|Nats-Timestamp|Nats-Subject|Nats-Stream)\b/g;

function isNatsLike(body) {
  return /\b(?:nc|nats|js|jsm)\.(publish|subscribe|request|jetstream|consume|pullSubscribe|streams|consumers|kv)\b|\bnats:\/\/|@nats-io\/|Nats-Msg-Id|stream\s*:\s*["'][A-Z]/.test(body);
}

function classifySubject(s) {
  if (s.includes('>')) return 'tail-wildcard';
  if (s.includes('*')) return 'single-wildcard';
  return 'literal';
}

function extractNats(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isNatsLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    method: 0, jsMethod: 0, subject: 0, stream: 0,
    durable: 0, policy: 0, header: 0,
    literal: 0, 'single-wildcard': 0, 'tail-wildcard': 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  METHOD_RE.lastIndex = 0;
  let m;
  while ((m = METHOD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('method', m[1], null);
  }
  if (entries.length < MAX_PER_FILE) {
    JS_METHOD_RE.lastIndex = 0;
    while ((m = JS_METHOD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('jsMethod', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    SUBJECT_RE.lastIndex = 0;
    while ((m = SUBJECT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const subj = m[1];
      // Filter to subjects with at least one dot
      if (!subj.includes('.')) continue;
      // Filter out file paths / version strings / similar
      if (/\.(js|ts|tsx|jsx|json|yaml|yml|md|css|html|png|jpg|svg)$/i.test(subj)) continue;
      const cls = classifySubject(subj);
      push('subject', subj.slice(0, 80), cls);
      if (totals[cls] != null) totals[cls] += 1;
    }
  }
  if (entries.length < MAX_PER_FILE) {
    STREAM_NAME_RE.lastIndex = 0;
    while ((m = STREAM_NAME_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('stream', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    DURABLE_RE.lastIndex = 0;
    while ((m = DURABLE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('durable', m[1].slice(0, 60), null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    POLICY_RE.lastIndex = 0;
    while ((m = POLICY_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('policy', m[1], m[2]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    NATS_HEADER_RE.lastIndex = 0;
    while ((m = NATS_HEADER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('header', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildNatsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    method: 0, jsMethod: 0, subject: 0, stream: 0,
    durable: 0, policy: 0, header: 0,
    literal: 0, 'single-wildcard': 0, 'tail-wildcard': 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractNats(txt);
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

function renderNatsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## NATS / JETSTREAM'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 14)) {
      const det = e.detail ? ` (${e.detail})` : '';
      lines.push(`- [${e.kind}] \`${e.name}\`${det}`);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractNats,
  buildNatsForFiles,
  renderNatsBlock,
  _internal: { isNatsLike, classifySubject },
};
