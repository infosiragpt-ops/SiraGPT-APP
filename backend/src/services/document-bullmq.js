'use strict';

/**
 * document-bullmq.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects BullMQ / Bull / Bee Queue job-queue framework usage:
 *
 *   - Queues:    new Queue('name', {...}) / new Bull('name')
 *   - Workers:   new Worker('name', processor, {...})
 *   - Events:    new QueueEvents('name') + .on('completed' / 'failed' / ...)
 *   - Flows:     new FlowProducer() / flowProducer.add({...})
 *   - Job ops:   queue.add(name, data, opts) / .addBulk / .remove / .getJob
 *   - Job opts:  delay / repeat (cron) / attempts / backoff / removeOnComplete
 *   - Worker:    .process(...) / .close() / .pause() / .resume()
 *   - Job state: 'waiting' / 'active' / 'completed' / 'failed' / 'delayed' /
 *                'prioritized' / 'paused' / 'stuck'
 *
 * Public API:
 *   extractBullmq(text)             → { entries, totals, total }
 *   buildBullmqForFiles(files)      → { perFile, aggregate, totals }
 *   renderBullmqBlock(report)       → markdown string ('' OK)
 */

const SCAN_HEAD_BYTES = 60_000;
const MAX_PER_FILE = 30;
const MAX_AGGREGATE = 28;
const MAX_BLOCK_CHARS = 4800;

const QUEUE_RE = /\bnew\s+(Queue|Bull|BeeQueue)\s*\(\s*["']([a-zA-Z][a-zA-Z0-9._:-]{0,60})["']/g;
const WORKER_RE = /\bnew\s+Worker\s*\(\s*["']([a-zA-Z][a-zA-Z0-9._:-]{0,60})["']/g;
const QUEUE_EVENTS_RE = /\bnew\s+QueueEvents\s*\(\s*["']([a-zA-Z][a-zA-Z0-9._:-]{0,60})["']/g;
const FLOW_PRODUCER_RE = /\bnew\s+FlowProducer\s*\(/g;
const JOB_ADD_RE = /\b[a-zA-Z_][a-zA-Z0-9_]*[Qq]ueue\.(add|addBulk|getJob|getJobs|remove|drain|obliterate|pause|resume|count|getWaitingCount|getActiveCount|getCompletedCount|getFailedCount)\s*\(/g;
const WORKER_OPS_RE = /\b(?:worker|[a-zA-Z_][a-zA-Z0-9_]*[Ww]orker|[a-zA-Z_][a-zA-Z0-9_]*[Ee]vents)\.(process|run|close|on|emit)\s*\(/g;
const JOB_OPT_RE = /\b(delay|repeat|attempts|backoff|removeOnComplete|removeOnFail|jobId|priority|lifo|timestamp|rateLimiterKey|stackTraceLimit|sizeLimit|deduplication|telemetry)\s*:\s*([0-9]+|true|false|["']?[^,}\n"']{1,80}["']?|\{)/g;
const JOB_STATE_RE = /["'](waiting|active|completed|failed|delayed|prioritized|paused|stuck|waiting-children|wait)["']/g;
const EVENT_ON_RE = /\.on\s*\(\s*["'](completed|failed|active|waiting|delayed|stalled|progress|error|drained|cleaned|removed)["']/g;
const CRON_OPT_RE = /\bcron\s*:\s*["']([^"'\n]{3,60})["']/g;

function isBullmqLike(body) {
  return /bullmq|@bull(?:mq)?\/|new\s+(?:Queue|Worker|QueueEvents|FlowProducer|Bull|BeeQueue)\s*\(|require\(['"]bull/.test(body);
}

function extractBullmq(text) {
  if (typeof text !== 'string' || !text) {
    return { entries: [], totals: {}, total: 0 };
  }
  const body = text.length > SCAN_HEAD_BYTES ? text.slice(0, SCAN_HEAD_BYTES) : text;
  if (!isBullmqLike(body)) {
    return { entries: [], totals: {}, total: 0 };
  }
  const seen = new Set();
  const entries = [];
  const totals = {
    queue: 0, worker: 0, queueEvents: 0, flowProducer: 0,
    jobAdd: 0, workerOp: 0, jobOpt: 0, jobState: 0,
    eventListener: 0, cron: 0,
  };

  function push(kind, name, detail) {
    const sig = `${kind}:${name}:${detail || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    entries.push({ kind, name, detail });
    if (totals[kind] != null) totals[kind] += 1;
  }

  QUEUE_RE.lastIndex = 0;
  let m;
  while ((m = QUEUE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
    push('queue', m[2], m[1]);
  }
  if (entries.length < MAX_PER_FILE) {
    WORKER_RE.lastIndex = 0;
    while ((m = WORKER_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('worker', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    QUEUE_EVENTS_RE.lastIndex = 0;
    while ((m = QUEUE_EVENTS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('queueEvents', m[1], null);
    }
  }

  let flowCount = 0;
  FLOW_PRODUCER_RE.lastIndex = 0;
  while (FLOW_PRODUCER_RE.exec(body) && flowCount < 5) flowCount += 1;
  totals.flowProducer = flowCount;
  if (flowCount && entries.length < MAX_PER_FILE) {
    entries.push({ kind: 'flowProducer', name: 'FlowProducer', detail: `${flowCount}` });
  }

  if (entries.length < MAX_PER_FILE) {
    JOB_ADD_RE.lastIndex = 0;
    while ((m = JOB_ADD_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('jobAdd', `.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    WORKER_OPS_RE.lastIndex = 0;
    while ((m = WORKER_OPS_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('workerOp', `.${m[1]}`, null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    JOB_OPT_RE.lastIndex = 0;
    while ((m = JOB_OPT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      const detail = m[2].length > 30 ? m[2].slice(0, 30) : m[2];
      push('jobOpt', m[1], detail);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    EVENT_ON_RE.lastIndex = 0;
    while ((m = EVENT_ON_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('eventListener', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    JOB_STATE_RE.lastIndex = 0;
    while ((m = JOB_STATE_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('jobState', m[1], null);
    }
  }
  if (entries.length < MAX_PER_FILE) {
    CRON_OPT_RE.lastIndex = 0;
    while ((m = CRON_OPT_RE.exec(body)) && entries.length < MAX_PER_FILE) {
      push('cron', m[1], null);
    }
  }

  return { entries, totals, total: entries.length };
}

function buildBullmqForFiles(files) {
  if (!Array.isArray(files)) return { perFile: [], aggregate: [], totals: {} };
  const perFile = [];
  const aggSeen = new Set();
  const aggregate = [];
  const totals = {
    queue: 0, worker: 0, queueEvents: 0, flowProducer: 0,
    jobAdd: 0, workerOp: 0, jobOpt: 0, jobState: 0,
    eventListener: 0, cron: 0,
  };
  for (const file of files) {
    const txt = file && file.extractedText;
    if (typeof txt !== 'string' || !txt) continue;
    const report = extractBullmq(txt);
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

function renderBullmqBlock(report) {
  if (!report || !Array.isArray(report.perFile) || report.perFile.length === 0) return '';
  const lines = ['## BULLMQ / BULL JOB QUEUES'];
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
  extractBullmq,
  buildBullmqForFiles,
  renderBullmqBlock,
  _internal: { isBullmqLike },
};
