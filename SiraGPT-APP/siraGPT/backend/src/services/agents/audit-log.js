/**
 * audit-log — structured append-only log for SE-agent activity.
 *
 * One JSON object per line, suitable for shipping to a log aggregator
 * (Loki, Datadog, Cloudwatch). Every agent invocation emits a record
 * with: timestamp, userId, agent, collection, iterations, terminatedBy,
 * tokens, durationMs, injection_hits (if any), error (if any).
 *
 * Destination:
 *   - Default: stderr (so Node's default logging pipeline captures it)
 *   - AUDIT_LOG_PATH=/path/to/file.ndjson → append to file
 *
 * Secrets redaction: before emit, the record passes through a redact()
 * pass that masks anything matching known secret patterns. Hard to be
 * perfect but catches API keys that leak via "error" fields.
 */

const fs = require('fs');
const path = require('path');

const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || null;

let fileStream = null;
if (AUDIT_LOG_PATH) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    fileStream = fs.createWriteStream(AUDIT_LOG_PATH, { flags: 'a' });
  } catch (err) {
    console.warn('[audit-log] failed to open file, falling back to stderr:', err.message);
  }
}

const SECRET_PATTERNS = [
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
  /"(api[_-]?key|secret|passwd|password|token|bearer)"\s*:\s*"[^"]{8,}"/gi,
];

function redactOne(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '<REDACTED>');
  }
  return out;
}

function redact(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactOne(obj);
  if (Array.isArray(obj)) return obj.map(redact);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = redact(v);
    return out;
  }
  return obj;
}

// ── lifecycle-event idempotency ──────────────────────────────────────
//
// `agent_task_worker_started` / `agent_task_worker_finished` /
// `agent_task_failed` / `agent_task_queued` were observed firing 2-4
// times for the same (taskId, jobId) at the same millisecond. Possible
// causes (multi-instance Autoscale dispatch, BullMQ stalled re-pickup,
// duplicate runAgentTaskJob invocations from boot recovery) all show
// the same symptom: spammy identical log lines that bloat the feed and
// drown out real signal.
//
// We dedupe at the audit() layer instead of at every call site because
// (a) it's the single chokepoint, (b) it works regardless of the
// upstream root cause, and (c) it preserves observability — the first
// hit emits normally, duplicates are counted silently, and when the
// window closes we emit ONE `agent_task_event_deduped` summary with
// `suppressedCount` so operators can still see the multiplication.
const DEDUPE_EVENTS = new Set([
  'agent_task_queued',
  'agent_task_worker_started',
  'agent_task_worker_finished',
  // Both names exist: route layer emits `agent_task_failed`, runner
  // layer emits `agent_task_worker_failed`. We dedupe both because the
  // duplicate-emission pattern affects every lifecycle event equally.
  'agent_task_failed',
  'agent_task_worker_failed',
]);
const DEDUPE_WINDOW_MS = 90 * 1000;
const dedupeState = new Map(); // key: `${event}:${taskId}[:${jobId}]` → { count, firstAt, timer }

/**
 * Compose the dedupe key. Including `jobId` (when present) is critical
 * for retry semantics: BullMQ retries reuse the same taskId but mint a
 * new jobId for each attempt, so a legitimate retry within 90s would
 * otherwise be silently suppressed and look like a hung task to ops.
 */
function _dedupeKey(record) {
  if (!record || typeof record !== 'object') return null;
  const { event, taskId, jobId } = record;
  if (!event || !taskId) return null;
  if (!DEDUPE_EVENTS.has(event)) return null;
  if (jobId !== undefined && jobId !== null && jobId !== '') {
    return `${event}:${taskId}:${jobId}`;
  }
  return `${event}:${taskId}`;
}

function _writeLine(line) {
  try {
    if (fileStream) {
      fileStream.write(line);
    } else {
      // Write to stderr so stdout (used for streaming responses) stays clean.
      process.stderr.write(line);
    }
  } catch {
    // swallow — audit loss is preferable to request failure
  }
}

function _flushDedupeEntry(key) {
  const entry = dedupeState.get(key);
  if (!entry) return;
  dedupeState.delete(key);
  if (entry.timer) {
    try { clearTimeout(entry.timer); } catch (_) { /* best-effort */ }
  }
  const suppressed = entry.count - 1;
  if (suppressed <= 0) return;
  // Parse `event:taskId[:jobId]` back out. Event is always the first
  // segment; jobId is optional. We split with a limit so a taskId that
  // happens to contain a colon (very rare, but defensible) still
  // reconstructs cleanly.
  const parts = key.split(':');
  const event = parts[0];
  const taskId = parts[1] || null;
  const jobId = parts.length >= 3 ? parts.slice(2).join(':') : null;
  const summary = redact({
    t: new Date().toISOString(),
    event: 'agent_task_event_deduped',
    suppressedEvent: event,
    taskId,
    jobId,
    suppressedCount: suppressed,
    windowMs: DEDUPE_WINDOW_MS,
    firstAt: new Date(entry.firstAt).toISOString(),
  });
  _writeLine(JSON.stringify(summary) + '\n');
}

/**
 * Emit one audit record. Non-blocking; never throws.
 *
 * Lifecycle events listed in DEDUPE_EVENTS go through an in-process
 * dedupe window keyed by `event+taskId`. First hit emits as usual;
 * duplicates within the window are silently counted and then summarised
 * in a single `agent_task_event_deduped` line when the window closes.
 */
function audit(record) {
  const dedupeKey = _dedupeKey(record);
  if (dedupeKey) {
    const existing = dedupeState.get(dedupeKey);
    if (existing) {
      existing.count += 1;
      return;
    }
    const timer = setTimeout(() => _flushDedupeEntry(dedupeKey), DEDUPE_WINDOW_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    dedupeState.set(dedupeKey, { count: 1, firstAt: Date.now(), timer });
  }
  const safe = redact({
    t: new Date().toISOString(),
    ...record,
  });
  _writeLine(JSON.stringify(safe) + '\n');
}

/**
 * Shorthand for the common "agent invocation ended" record.
 */
function auditAgentRun({ userId, agent, collection, result, extra = {} }) {
  audit({
    event: 'agent_run',
    userId: userId || null,
    agent,
    collection: collection || null,
    iterations: result?.iterations ?? null,
    terminatedBy: result?.terminatedBy ?? null,
    durationMs: result?.stats?.durationMs ?? null,
    tokens: result?.stats
      ? (result.stats.approxPromptTokens || 0) + (result.stats.approxCompletionTokens || 0)
      : null,
    toolCalls: result?.stats?.toolCalls ?? null,
    toolCacheHits: result?.stats?.toolCacheHits ?? null,
    ...extra,
  });
}

function _flush() {
  if (fileStream) {
    return new Promise(resolve => fileStream.end(resolve));
  }
  return Promise.resolve();
}

/**
 * Project a documentPolicy down to the fields that are actually useful in
 * the log feed. The full object carries a colour palette, threshold knobs,
 * and other UI metadata that bloated every `agent_task_*` line to ~1.5 KB
 * of noise without adding diagnostic value. Keep only the routing-relevant
 * fields so operators can still grep by mode/template/complexity.
 */
function slimDocumentPolicy(policy) {
  if (!policy || typeof policy !== 'object') return policy ?? null;
  const {
    mode = null,
    format = null,
    template = null,
    complexity = null,
    autoGenerate = null,
    reason = null,
  } = policy;
  return { mode, format, template, complexity, autoGenerate, reason };
}

/**
 * Test-only: drop any pending dedupe entries without emitting a summary.
 * Production code must never call this — it's wired so unit tests can
 * isolate window behaviour without leaking state between cases.
 */
function _resetDedupeStateForTests() {
  for (const entry of dedupeState.values()) {
    if (entry?.timer) {
      try { clearTimeout(entry.timer); } catch (_) { /* best-effort */ }
    }
  }
  dedupeState.clear();
}

/**
 * Test-only: force a dedupe window to close immediately and emit the
 * summary if there were suppressed duplicates. Lets tests assert the
 * summary-emission path deterministically without faking timers or
 * waiting 90s. `key` is the same `event:taskId[:jobId]` shape the
 * internal Map uses.
 */
function _forceFlushDedupeForTests(key) {
  _flushDedupeEntry(key);
}

module.exports = {
  audit,
  auditAgentRun,
  redact,
  slimDocumentPolicy,
  _flush, // for tests
  _resetDedupeStateForTests, // for tests
  _forceFlushDedupeForTests, // for tests
};
