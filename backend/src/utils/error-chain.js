'use strict';

/**
 * describeErrorChain — one redacted line naming an error AND its root cause.
 *
 * Provider SDKs wrap network failures several levels deep
 * (`APIConnectionError('Connection error.')` → `TypeError('fetch failed')` →
 * undici `ConnectTimeoutError { code: 'UND_ERR_CONNECT_TIMEOUT' }`), and a
 * log line that prints only `err.message` loses the code the operator needs.
 * A non-Error rejection reason printed with `String(reason)` is
 * `[object Object]`. This walks `.cause` (cycle-safe, bounded), appends
 * `code=` / `status=` / `req=<provider request id>` per level, inspects
 * non-Errors shallowly and redacts secrets.
 */

const util = require('node:util');
const { redactString } = require('./secret-redactor');

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_LEN = 600;

function describeOne(value) {
  if (value instanceof Error) {
    const head = `${value.name || 'Error'}: ${value.message || ''}`.trim();
    const meta = [];
    if (value.code !== undefined && value.code !== null && value.code !== '') meta.push(`code=${String(value.code)}`);
    const status = value.status !== undefined && value.status !== null ? value.status : value.statusCode;
    if (status !== undefined && status !== null && status !== '') meta.push(`status=${String(status)}`);
    const requestId = value.requestID || value.requestId || value.request_id;
    if (requestId) meta.push(`req=${String(requestId)}`);
    return meta.length ? `${head} [${meta.join(' ')}]` : head;
  }
  if (value === undefined || value === null) return String(value);
  if (typeof value === 'string') return value;
  try {
    return util.inspect(value, { depth: 1, breakLength: Infinity, compact: true });
  } catch {
    return String(value);
  }
}

function describeErrorChain(err, { maxDepth = DEFAULT_MAX_DEPTH, maxLen = DEFAULT_MAX_LEN } = {}) {
  const seen = new Set();
  const segments = [];
  let current = err;
  let depth = 0;
  while (current !== undefined && current !== null && depth < Math.max(1, maxDepth)) {
    if (typeof current === 'object' || typeof current === 'function') {
      if (seen.has(current)) {
        segments.push('[circular cause]');
        break;
      }
      seen.add(current);
    }
    segments.push(describeOne(current));
    const next = current && typeof current === 'object' ? current.cause : undefined;
    if (next === undefined || next === null) break;
    current = next;
    depth += 1;
  }
  if (!segments.length) segments.push(String(err));
  let text = segments.join(' ← ').replace(/\s+/g, ' ').trim();
  try {
    text = redactString(text);
  } catch {
    /* keep the raw text rather than lose the line */
  }
  const cap = Math.max(16, Number(maxLen) || DEFAULT_MAX_LEN);
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

module.exports = { describeErrorChain, DEFAULT_MAX_DEPTH, DEFAULT_MAX_LEN };
