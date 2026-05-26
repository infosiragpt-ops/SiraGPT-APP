'use strict';

/**
 * document-kafka-refs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects Apache Kafka references in runbooks / debug logs / config docs:
 *
 *   - topic names:    "topic foo.bar", "topic: orders.created"
 *   - consumer group: "group.id: my-consumer", "consumer-group ..."
 *   - partition:      "partition 0", "[partition=3]"
 *   - offset:         "offset 12345", "committed offset 999"
 *   - kafka command:  kafka-topics.sh, kafka-console-consumer
 *
 * Public API:
 *   extractKafkaRefs(text)             → { entries, totals, total }
 *   buildKafkaRefsForFiles(files)      → { perFile, aggregate, totals }
 *   renderKafkaRefsBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 18;
const MAX_AGGREGATE = 24;
const MAX_BLOCK_CHARS = 4500;

const TOPIC_RE = /\b(?:topic|topics)\s*[:=]?\s*([a-z][a-z0-9._-]{2,80})/gi;
const CONSUMER_GROUP_RE = /\b(?:group\.id|consumer[-\s]group)\s*[:=]\s*([a-zA-Z][a-zA-Z0-9._-]{2,80})/g;
const PARTITION_RE = /\b(?:partition|partitions)\s*[:=]?\s*(\d{1,5})\b/gi;
const OFFSET_RE = /\b(?:offset|committed\s+offset|last\s+offset)\s*[:=]?\s*(\d{1,15})/gi;
const KAFKA_CMD_RE = /\b(kafka-(?:topics|console-consumer|console-producer|consumer-groups|configs|run-class)(?:\.sh)?)\b/g;
const BOOTSTRAP_RE = /\bbootstrap[._-]servers?\s*[:=]\s*([a-z0-9][a-z0-9.,:_-]{4,200})/gi;

function looksLikeTopic(s) {
  if (!s || s.length < 3 || s.length > 80) return false;
  // Reject reserved words
  if (/^(?:default|test|all|none|null|undefined|true|false)$/i.test(s)) return false;
  return /[a-z]/.test(s);
}

function extractKafkaRefs(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  const seen = new Set();
  const entries = [];
  const totals = { topic: 0, consumerGroup: 0, partition: 0, offset: 0, command: 0, bootstrap: 0 };

  function push(kind, value) {
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ kind, value });
    if (totals[kind] != null) totals[kind] += 1;
  }

  TOPIC_RE.lastIndex = 0;
  let m;
  while ((m = TOPIC_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    const t = m[1];
    if (!looksLikeTopic(t)) continue;
    push('topic', t);
  }
  if (entries.length < MAX_PER_FILE) {
    CONSUMER_GROUP_RE.lastIndex = 0;
    while ((m = CONSUMER_GROUP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('consumerGroup', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    PARTITION_RE.lastIndex = 0;
    while ((m = PARTITION_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('partition', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    OFFSET_RE.lastIndex = 0;
    while ((m = OFFSET_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('offset', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    KAFKA_CMD_RE.lastIndex = 0;
    while ((m = KAFKA_CMD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('command', m[1]);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    BOOTSTRAP_RE.lastIndex = 0;
    while ((m = BOOTSTRAP_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('bootstrap', m[1].slice(0, 80));
    }
  }

  return { entries, totals, total: entries.length };
}

function buildKafkaRefsForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = { topic: 0, consumerGroup: 0, partition: 0, offset: 0, command: 0, bootstrap: 0 };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractKafkaRefs(txt);
    if (report.total === 0) continue;
    perFile.push({ name: file.name || '(unnamed)', report });
    for (const e of report.entries) {
      const key = `${e.kind}:${e.value}`;
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

function renderKafkaRefsBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## KAFKA REFERENCES'];
  const t = report.totals || {};
  const parts = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  if (parts.length) lines.push(`- Totals: ${parts.join(', ')}`);
  for (const { name, report: r } of report.perFile) {
    lines.push(`### ${name}`);
    for (const e of r.entries.slice(0, 10)) {
      lines.push(`- ${e.kind}: \`${e.value}\``);
    }
  }
  const out = lines.join('\n');
  return out.length > MAX_BLOCK_CHARS ? `${out.slice(0, MAX_BLOCK_CHARS)}\n…` : out;
}

module.exports = {
  extractKafkaRefs,
  buildKafkaRefsForFiles,
  renderKafkaRefsBlock,
  _internal: { looksLikeTopic },
};
