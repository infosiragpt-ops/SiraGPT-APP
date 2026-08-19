'use strict';

/**
 * alerting.js — pluggable alerting hooks with severity + dedup.
 *
 * Channels (all opt-in via env, all best-effort, never throw):
 *   - Slack:     SLACK_ALERT_WEBHOOK_URL
 *   - PagerDuty: PAGERDUTY_INTEGRATION_KEY  (Events API v2)
 *   - Email:     ALERT_EMAIL_WEBHOOK_URL   (generic HTTP POST relay)
 *
 * Severity levels: 'info' | 'warn' | 'error' | 'critical'
 * Dedup: same `title` within `DEDUP_WINDOW_MS` (default 5 minutes) is
 * suppressed and recorded as a `suppressed_count` increment.
 *
 * Wiring helpers exported:
 *   - notifyCircuitBreakerOpen(breaker)   warn
 *   - notifyHighMemory(usagePct)          error  (>80% heap)
 *   - notifyDbPoolExhausted(details)      critical
 *   - notifyHigh5xxRate(ratePct)          error  (>5% / 1min)
 *   - notifyFrontendError(payload)        info   (via /api/telemetry/error)
 *
 * Call `attachCircuitBreaker(breaker)` once per CircuitBreaker instance
 * to receive `stateChange` events automatically.
 */

const DEFAULT_DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const VALID_SEVERITIES = new Set(['info', 'warn', 'error', 'critical']);

const _dedupCache = new Map(); // title → { lastSentAt, suppressedSince, count }
let _logger = console;
let _dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS;
const _customChannels = [];
let _fetchImpl = null;

function _now() { return Date.now(); }

function _resolveFetch() {
  if (_fetchImpl) return _fetchImpl;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  return null;
}

function _safeStr(v, n = 500) {
  try { return String(v).slice(0, n); } catch { return ''; }
}

function _pdSeverity(sev) {
  // PagerDuty Events API v2 only accepts: critical, error, warning, info
  if (sev === 'warn') return 'warning';
  return sev;
}

async function _postJson(url, body, { timeoutMs = 5000 } = {}) {
  const f = _resolveFetch();
  if (!f) return { ok: false, reason: 'no_fetch' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, reason: _safeStr(err && err.message) };
  } finally {
    clearTimeout(t);
  }
}

// ── Channels ──────────────────────────────────────────────────────────

async function _sendSlack({ title, message, severity, context }) {
  const url = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!url) return { skipped: 'not_configured' };
  const emoji = severity === 'critical' ? ':rotating_light:'
    : severity === 'error' ? ':red_circle:'
    : severity === 'warn' ? ':warning:' : ':information_source:';
  const text = `${emoji} *[${severity.toUpperCase()}]* ${title}\n${message || ''}` +
    (context ? `\n\`\`\`${_safeStr(JSON.stringify(context), 1500)}\`\`\`` : '');
  return _postJson(url, { text });
}

async function _sendPagerDuty({ title, message, severity, context }) {
  const key = process.env.PAGERDUTY_INTEGRATION_KEY;
  if (!key) return { skipped: 'not_configured' };
  const body = {
    routing_key: key,
    event_action: 'trigger',
    dedup_key: title,
    payload: {
      summary: `[${severity.toUpperCase()}] ${title}`,
      source: process.env.PD_SOURCE || 'siragpt-backend',
      severity: _pdSeverity(severity),
      custom_details: { message: message || '', context: context || {} },
    },
  };
  return _postJson('https://events.pagerduty.com/v2/enqueue', body);
}

async function _sendEmail({ title, message, severity, context }) {
  const url = process.env.ALERT_EMAIL_WEBHOOK_URL;
  if (!url) return { skipped: 'not_configured' };
  return _postJson(url, {
    to: process.env.ALERT_EMAIL_TO || '',
    subject: `[siraGPT][${severity}] ${title}`,
    text: `${message || ''}\n\nContext: ${_safeStr(JSON.stringify(context || {}), 2000)}`,
  });
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Send an alert through every configured channel. Always resolves
 * — channel errors are logged but never thrown.
 *
 * @param {object}   alert
 * @param {string}   alert.title       Stable string used for dedup
 * @param {string}   alert.message     Human-readable description
 * @param {'info'|'warn'|'error'|'critical'} alert.severity
 * @param {object}   [alert.context]   Extra structured context
 */
async function sendAlert({ title, message = '', severity = 'info', context = null } = {}) {
  if (!title || typeof title !== 'string') {
    return { ok: false, error: 'title_required' };
  }
  if (!VALID_SEVERITIES.has(severity)) severity = 'info';

  // ── Dedup ───────────────────────────────────────────────────────────
  const now = _now();
  const entry = _dedupCache.get(title);
  if (entry && (now - entry.lastSentAt) < _dedupWindowMs) {
    entry.count = (entry.count || 1) + 1;
    return { ok: true, suppressed: true, count: entry.count };
  }
  _dedupCache.set(title, { lastSentAt: now, count: 1 });

  // Periodically prune
  if (_dedupCache.size > 256) {
    for (const [k, v] of _dedupCache) {
      if ((now - v.lastSentAt) > _dedupWindowMs * 4) _dedupCache.delete(k);
    }
  }

  try {
    if (_logger && typeof _logger.info === 'function') {
      const fn = severity === 'critical' || severity === 'error' ? (_logger.error || _logger.info)
        : severity === 'warn' ? (_logger.warn || _logger.info)
        : _logger.info;
      try { fn.call(_logger, { alert: { title, severity, message, context } }, 'alert_emitted'); } catch {}
    }
  } catch { /* never throw */ }

  const payload = { title, message, severity, context };
  const results = await Promise.allSettled([
    _sendSlack(payload),
    _sendPagerDuty(payload),
    _sendEmail(payload),
    ..._customChannels.map((ch) => Promise.resolve().then(() => ch(payload))),
  ]);
  return {
    ok: true,
    channels: results.map((r, i) => ({
      index: i,
      status: r.status,
      value: r.status === 'fulfilled' ? r.value : _safeStr(r.reason && r.reason.message),
    })),
  };
}

function configure({ logger, dedupWindowMs, fetchImpl } = {}) {
  if (logger) _logger = logger;
  if (Number.isFinite(dedupWindowMs) && dedupWindowMs > 0) _dedupWindowMs = dedupWindowMs;
  if (typeof fetchImpl === 'function') _fetchImpl = fetchImpl;
}

function registerChannel(fn) {
  if (typeof fn !== 'function') throw new TypeError('registerChannel: fn required');
  _customChannels.push(fn);
  return () => {
    const i = _customChannels.indexOf(fn);
    if (i !== -1) _customChannels.splice(i, 1);
  };
}

/**
 * getActiveAlerts — snapshot of alerts whose dedup entry is still within
 * the active window. Useful for the system-summary dashboard so on-call
 * sees a number of "currently firing" alerts at a glance.
 *
 * Returns `{ count, items: [{ title, lastSentAt, count, suppressedCount }] }`.
 */
function getActiveAlerts({ now = _now(), windowMs = _dedupWindowMs } = {}) {
  const items = [];
  for (const [title, entry] of _dedupCache) {
    if (!entry || typeof entry.lastSentAt !== 'number') continue;
    if ((now - entry.lastSentAt) > windowMs) continue;
    items.push({
      title,
      lastSentAt: new Date(entry.lastSentAt).toISOString(),
      count: entry.count || 1,
    });
  }
  // Most-recent first. 3-way result: returning -1 on ties (b === a) violated
  // the sort contract (non-antisymmetric), giving engine-defined order for
  // alerts sharing a millisecond timestamp. ISO strings compare chronologically.
  items.sort((a, b) => (b.lastSentAt > a.lastSentAt ? 1 : b.lastSentAt < a.lastSentAt ? -1 : 0));
  return { count: items.length, windowMs, items };
}

function _resetForTests() {
  _dedupCache.clear();
  _customChannels.length = 0;
  _dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS;
  _fetchImpl = null;
  _logger = console;
}

// ── Domain-specific helpers (wiring) ──────────────────────────────────

function notifyCircuitBreakerOpen(breaker) {
  const name = (breaker && breaker.name) || 'unknown';
  return sendAlert({
    title: `circuit_breaker_opened:${name}`,
    message: `Circuit breaker "${name}" transitioned to OPEN`,
    severity: 'warn',
    context: typeof breaker?.toJSON === 'function' ? breaker.toJSON() : { name },
  });
}

function notifyHighMemory(usagePct, extra = {}) {
  return sendAlert({
    title: 'memory_high_heap_usage',
    message: `Heap usage ${usagePct.toFixed(1)}% exceeds 80% threshold`,
    severity: 'error',
    context: { usagePct, ...extra },
  });
}

function notifyDbPoolExhausted(details = {}) {
  return sendAlert({
    title: 'db_pool_exhausted',
    message: 'Prisma/Postgres connection pool exhausted',
    severity: 'critical',
    context: details,
  });
}

function notifyHigh5xxRate(ratePct, details = {}) {
  return sendAlert({
    title: 'http_5xx_rate_high',
    message: `5xx error rate ${ratePct.toFixed(2)}% exceeds 5% over 1 minute`,
    severity: 'error',
    context: { ratePct, ...details },
  });
}

function notifyFrontendError(payload = {}) {
  // Truncate large stacks/messages so the alert channel isn't spammed.
  const msg = _safeStr(payload.message || payload.error || '', 200);
  return sendAlert({
    title: `frontend_error_boundary:${_safeStr(payload.page || 'unknown', 80)}`,
    message: msg,
    severity: 'info',
    context: {
      page: payload.page,
      stack: _safeStr(payload.stack || '', 1500),
      userAgent: _safeStr(payload.userAgent || '', 200),
      userId: payload.userId || null,
    },
  });
}

function attachCircuitBreaker(breaker) {
  if (!breaker || typeof breaker.on !== 'function') return () => {};
  const handler = (evt) => {
    if (evt && evt.to === 'open') {
      // Fire-and-forget — alerting never blocks the breaker path.
      Promise.resolve().then(() => notifyCircuitBreakerOpen(breaker)).catch(() => {});
    }
  };
  breaker.on('stateChange', handler);
  return () => { try { breaker.off?.('stateChange', handler); } catch {} };
}

module.exports = {
  sendAlert,
  configure,
  registerChannel,
  notifyCircuitBreakerOpen,
  notifyHighMemory,
  notifyDbPoolExhausted,
  notifyHigh5xxRate,
  notifyFrontendError,
  attachCircuitBreaker,
  getActiveAlerts,
  _resetForTests,
};
