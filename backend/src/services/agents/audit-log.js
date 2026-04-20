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

/**
 * Emit one audit record. Non-blocking; never throws.
 */
function audit(record) {
  const safe = redact({
    t: new Date().toISOString(),
    ...record,
  });
  const line = JSON.stringify(safe) + '\n';
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

module.exports = {
  audit,
  auditAgentRun,
  redact,
  _flush, // for tests
};
