/**
 * metrics.js — minimal in-memory Prometheus-compatible registry.
 *
 * Self-contained: no prom-client dependency. Lives at the utility tier so
 * other modules can `require('./metrics')` defensively (inside try/catch)
 * without pulling in agent/service code.
 *
 * Supports three metric types: counter, gauge, histogram. Histograms use
 * user-supplied bucket boundaries (le buckets) plus an implicit +Inf
 * bucket and a `_sum` / `_count` line.
 *
 * The companion `agents/metrics.js` registry continues to live alongside
 * this one for legacy series. `/metrics` reads both.
 */

'use strict';

// name → { type, help, labels, series: Map<labelKey, value|histogramRecord> [, buckets] }
const registry = new Map();

function _normalizeLabels(labels) {
  if (!labels) return {};
  if (typeof labels !== 'object') return {};
  return labels;
}

function _labelKey(labelNames, labels) {
  const norm = _normalizeLabels(labels);
  return labelNames
    .map((n) => `${n}=${String(norm[n] ?? '').replace(/[\\"\n,]/g, '_')}`)
    .join(',');
}

function registerCounter(name, { help = '', labels = [] } = {}) {
  if (registry.has(name)) return;
  registry.set(name, { type: 'counter', help, labels, series: new Map() });
}

function registerGauge(name, { help = '', labels = [] } = {}) {
  if (registry.has(name)) return;
  registry.set(name, { type: 'gauge', help, labels, series: new Map() });
}

function registerHistogram(name, { help = '', labels = [], buckets = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] } = {}) {
  if (registry.has(name)) return;
  // Defensive copy, sorted ascending
  const sortedBuckets = Array.from(new Set(buckets.map(Number).filter((n) => Number.isFinite(n))))
    .sort((a, b) => a - b);
  registry.set(name, { type: 'histogram', help, labels, buckets: sortedBuckets, series: new Map() });
}

function counter(name, labels = {}, delta = 1) {
  const m = registry.get(name);
  if (!m || m.type !== 'counter') return;
  if (!Number.isFinite(delta) || delta < 0) return;
  const k = _labelKey(m.labels, labels);
  m.series.set(k, (m.series.get(k) || 0) + delta);
}

function gauge(name, labels = {}, value = 0) {
  const m = registry.get(name);
  if (!m || m.type !== 'gauge') return;
  if (!Number.isFinite(value)) return;
  m.series.set(_labelKey(m.labels, labels), value);
}

function observe(name, labels = {}, value = 0) {
  const m = registry.get(name);
  if (!m || m.type !== 'histogram') return;
  if (!Number.isFinite(value) || value < 0) return;
  const k = _labelKey(m.labels, labels);
  let rec = m.series.get(k);
  if (!rec) {
    rec = { count: 0, sum: 0, bucketCounts: new Array(m.buckets.length).fill(0) };
    m.series.set(k, rec);
  }
  rec.count += 1;
  rec.sum += value;
  for (let i = 0; i < m.buckets.length; i += 1) {
    if (value <= m.buckets[i]) rec.bucketCounts[i] += 1;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────

function _escapeLabelValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function _renderLabelString(labelNames, key, extra) {
  const parts = [];
  if (key) {
    const pieces = key.split(',');
    for (let i = 0; i < pieces.length; i += 1) {
      const eq = pieces[i].indexOf('=');
      const value = eq >= 0 ? pieces[i].slice(eq + 1) : '';
      parts.push(`${labelNames[i]}="${_escapeLabelValue(value)}"`);
    }
  }
  if (extra) parts.push(extra);
  return parts.length ? `{${parts.join(',')}}` : '';
}

function _renderCounter(name, m) {
  const out = [`# HELP ${name} ${m.help || ''}`, `# TYPE ${name} counter`];
  if (m.series.size === 0) {
    out.push(`${name} 0`);
  } else {
    for (const [k, v] of m.series) {
      out.push(`${name}${_renderLabelString(m.labels, k)} ${v}`);
    }
  }
  return out.join('\n');
}

function _renderGauge(name, m) {
  const out = [`# HELP ${name} ${m.help || ''}`, `# TYPE ${name} gauge`];
  if (m.series.size === 0) {
    out.push(`${name} 0`);
  } else {
    for (const [k, v] of m.series) {
      out.push(`${name}${_renderLabelString(m.labels, k)} ${v}`);
    }
  }
  return out.join('\n');
}

function _renderHistogram(name, m) {
  const out = [`# HELP ${name} ${m.help || ''}`, `# TYPE ${name} histogram`];
  for (const [k, rec] of m.series) {
    for (let i = 0; i < m.buckets.length; i += 1) {
      out.push(
        `${name}_bucket${_renderLabelString(m.labels, k, `le="${m.buckets[i]}"`)} ${rec.bucketCounts[i]}`,
      );
    }
    out.push(`${name}_bucket${_renderLabelString(m.labels, k, 'le="+Inf"')} ${rec.count}`);
    out.push(`${name}_sum${_renderLabelString(m.labels, k)} ${rec.sum}`);
    out.push(`${name}_count${_renderLabelString(m.labels, k)} ${rec.count}`);
  }
  return out.join('\n');
}

/** Render the entire registry in Prometheus text-exposition format. */
function renderText() {
  const blocks = [];
  for (const [name, m] of registry) {
    if (m.type === 'counter') blocks.push(_renderCounter(name, m));
    else if (m.type === 'gauge') blocks.push(_renderGauge(name, m));
    else if (m.type === 'histogram') blocks.push(_renderHistogram(name, m));
  }
  return `${blocks.join('\n\n')}\n`;
}

function _reset() {
  for (const m of registry.values()) m.series.clear();
}

function _clearRegistry() {
  registry.clear();
}

// ── Default metric families used by /metrics ─────────────────────────────
registerCounter('siragpt_http_requests_total', {
  help: 'Total HTTP requests served by SiraGPT, labelled by method, matched route, and status code',
  labels: ['method', 'route', 'status'],
});
registerHistogram('siragpt_http_request_duration_seconds', {
  help: 'HTTP request latency in seconds, bucketed for Prometheus histograms',
  labels: ['method', 'route'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
registerGauge('siragpt_circuit_breaker_state', {
  help: 'Circuit breaker state per named breaker (0=closed, 1=half_open, 2=open)',
  labels: ['name'],
});
registerGauge('siragpt_async_guards_active', {
  help: 'Active AsyncGuard tokens currently tracked in this process',
  labels: [],
});
registerCounter('siragpt_analyzer_cache_hits_total', {
  help: 'Document professional analyzer in-process cache hits',
  labels: [],
});
registerCounter('siragpt_gdpr_content_scrubbed_total', {
  help: 'Total messages + files redacted by the GDPR content scrub job (cycle 29)',
  labels: ['kind'],
});
registerCounter('siragpt_apiusage_pruned_total', {
  help: 'Total ApiUsage records pruned (kind=row) or summaries upserted (kind=summary) by the 90-day retention job',
  labels: ['kind'],
});
registerCounter('siragpt_analyzer_cache_misses_total', {
  help: 'Document professional analyzer in-process cache misses',
  labels: [],
});
registerGauge('siragpt_process_uptime_seconds', {
  help: 'Process uptime in seconds (from process.uptime())',
  labels: [],
});
registerGauge('siragpt_nodejs_memory_bytes', {
  help: 'Resident Node.js memory in bytes, labelled by type (rss, heapUsed, heapTotal, external)',
  labels: ['type'],
});

// ── AI streaming usage metrics (cycle 46) ─────────────────────────────
// Wired from the /api/ai/generate streaming `usage` event so we can
// observe per-model / per-provider token consumption, dollar spend,
// and end-to-end latency from the SSE response trailer.
registerCounter('siragpt_ai_tokens_total', {
  help: 'Total AI tokens accounted via streaming usage trailer, labelled by model, provider, and kind (input|output)',
  labels: ['model', 'provider', 'kind'],
});
registerCounter('siragpt_ai_request_cost_usd_total', {
  help: 'Total AI request cost in USD, labelled by model and provider',
  labels: ['model', 'provider'],
});
registerHistogram('siragpt_ai_request_duration_seconds', {
  help: 'AI streaming request end-to-end duration in seconds, labelled by model and provider',
  labels: ['model', 'provider'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120],
});

// ── GDPR export metrics (ratchet 45) ─────────────────────────────────
// Wired from the /api/users/me/export route so we can observe per-user
// export size, build duration, and total throughput from /metrics.
registerHistogram('siragpt_gdpr_export_size_bytes', {
  help: 'GDPR export ZIP size in bytes, labelled by redactPII flag',
  labels: ['redactPII'],
  buckets: [
    1_024, 10_240, 102_400, 1_048_576, 5_242_880, 10_485_760,
    52_428_800, 104_857_600, 524_288_000,
  ],
});
registerHistogram('siragpt_gdpr_export_duration_seconds', {
  help: 'GDPR export build + serialisation duration in seconds, labelled by redactPII flag',
  labels: ['redactPII'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
});
registerCounter('siragpt_gdpr_exports_total', {
  help: 'Total GDPR exports successfully built, labelled by redactPII flag',
  labels: ['redactPII'],
});

// ── Org-members gauge (cycle 85) ────────────────────────────────────
// Active membership count per organization, refreshed whenever the
// members cache is invalidated (which already happens on every
// OrgMembership create/delete/role-change). Useful for billing /
// usage dashboards that want to size plan headcount over time.
registerGauge('siragpt_org_members_total', {
  help: 'Active OrgMembership rows per organization, refreshed on member-cache invalidation',
  labels: ['orgId'],
});

// ── API-key request latency + active gauge (ratchet 44) ────────────
// Histogram observed from `requireScope` middleware on every authenticated
// API-key request. Labels:
//   prefix       — the API key's public prefix (low cardinality)
//   method       — HTTP verb (GET/POST/PUT/PATCH/DELETE/...)
//   statusBand   — coarse status family: 2xx / 3xx / 4xx / 5xx
// Buckets are tighter than the global HTTP histogram so we can spot slow
// API-key paths without renormalising the default series.
registerHistogram('siragpt_api_key_request_duration_seconds', {
  help: 'API-key authenticated request latency in seconds, labelled by prefix, method, and status band',
  labels: ['prefix', 'method', 'statusBand'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
// Gauge — count of "live" API keys (not soft-deleted, not expired).
// Refreshed from the system-cron tick (see system-cron.js recordRun).
registerGauge('siragpt_api_keys_active_total', {
  help: 'Active API keys (deletedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now))',
  labels: [],
});

// ── Org-events SSE metrics (cycle 79) ───────────────────────────────
// Wired from the GET /api/orgs/:id/events SSE handler so dashboards can
// observe live-tail subscriber counts and total events streamed.
registerCounter('siragpt_org_events_streamed_total', {
  help: 'Total org-audit SSE events streamed to subscribers, labelled by orgId',
  labels: ['orgId'],
});
registerGauge('siragpt_org_events_active_subscribers', {
  help: 'Active subscribers currently connected to /api/orgs/:id/events SSE feeds',
  labels: [],
});

// ── Webhook delivery metrics (ratchet 45) ───────────────────────────
// Observed once per outbound HTTP attempt from webhook-dispatcher, with
// `event` (e.g. `task.completed`) and `ok` (`true` for 2xx/3xx, `false`
// otherwise — including timeouts and aborts) labels. Buckets span the
// dispatcher's configured request timeout (10s) with headroom for the
// retry-with-backoff overall envelope.
registerHistogram('siragpt_webhook_delivery_duration_seconds', {
  help: 'Webhook outbound HTTP attempt latency in seconds, labelled by event and ok flag',
  labels: ['event', 'ok'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

// ── System-cron health metrics (ratchet 45) ─────────────────────────
// Updated by `system-cron`'s recordRun() after each successful run so
// dashboards / alerts can distinguish "job ran recently" from "job is
// stale / silently broken". The timestamp gauge is epoch seconds (the
// Prometheus canonical form) and the histogram observes the just-run
// duration in seconds for percentile slicing per job.
registerGauge('siragpt_cron_last_success_timestamp', {
  help: 'Epoch seconds of the last successful run for each system-cron job',
  labels: ['job'],
});
registerHistogram('siragpt_cron_last_duration_seconds', {
  help: 'Duration of the last completed system-cron job in seconds, labelled by job',
  labels: ['job'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900],
});

// ── Maintenance-mode metrics (cycle 72) ─────────────────────────────
// Incremented from the maintenance-mode middleware whenever a request
// is short-circuited with HTTP 503 because the global maintenance flag
// is enabled. The `route` label captures `req.path` so dashboards can
// see which routes were being hit during a maintenance window.
registerCounter('siragpt_maintenance_blocked_total', {
  help: 'Total requests short-circuited with HTTP 503 by the maintenance-mode middleware, labelled by route',
  labels: ['route'],
});

/**
 * Record a single GDPR export sample from the /api/users/me/export
 * handler. All arguments are best-effort: non-finite or missing values
 * are coerced to safe defaults so instrumentation NEVER breaks the
 * export path.
 *
 * @param {object} opts
 * @param {number} opts.zipBytes
 * @param {number} opts.durationSeconds
 * @param {boolean} opts.redactPII
 */
function recordGdprExport(opts) {
  try {
    const { zipBytes = 0, durationSeconds = 0, redactPII = false } = opts || {};
    const labels = { redactPII: redactPII ? 'true' : 'false' };
    const bytes = Number.isFinite(zipBytes) ? Math.max(0, zipBytes) : 0;
    const dur = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
    if (bytes > 0) observe('siragpt_gdpr_export_size_bytes', labels, bytes);
    if (dur > 0) observe('siragpt_gdpr_export_duration_seconds', labels, dur);
    counter('siragpt_gdpr_exports_total', labels, 1);
  } catch {
    // never throw from instrumentation
  }
}

/**
 * Record a single AI streaming usage sample from the /generate
 * stream end handler. All arguments are best-effort: non-finite or
 * missing values are coerced to safe defaults so instrumentation
 * NEVER breaks the request path.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.provider
 * @param {number} opts.inputTokens
 * @param {number} opts.outputTokens
 * @param {number} opts.costUSD
 * @param {number} opts.durationSeconds
 */
function recordAIStreamUsage(opts) {
  try {
    const {
      model,
      provider,
      inputTokens = 0,
      outputTokens = 0,
      costUSD = 0,
      durationSeconds = 0,
    } = opts || {};
    const labelBase = {
      model: String(model || 'unknown'),
      provider: String(provider || 'unknown'),
    };
    const inTok = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
    const outTok = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
    if (inTok > 0) counter('siragpt_ai_tokens_total', { ...labelBase, kind: 'input' }, inTok);
    if (outTok > 0) counter('siragpt_ai_tokens_total', { ...labelBase, kind: 'output' }, outTok);
    const cost = Number.isFinite(costUSD) ? Math.max(0, costUSD) : 0;
    if (cost > 0) counter('siragpt_ai_request_cost_usd_total', labelBase, cost);
    const dur = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
    if (dur > 0) observe('siragpt_ai_request_duration_seconds', labelBase, dur);
  } catch {
    // never throw from instrumentation
  }
}

// ── Helpers that snapshot live state into the registry ───────────────────

const CB_STATE_VALUE = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };

/**
 * Track a CircuitBreaker instance — every time the breaker transitions
 * state, the gauge is updated. Records the initial state too.
 */
function trackCircuitBreaker(breaker) {
  if (!breaker || typeof breaker.on !== 'function') return;
  try {
    const initial = typeof breaker.state === 'string' ? breaker.state : 'CLOSED';
    gauge('siragpt_circuit_breaker_state', { name: breaker.name }, CB_STATE_VALUE[initial] ?? 0);
    breaker.on('stateChange', ({ to, name }) => {
      gauge('siragpt_circuit_breaker_state', { name }, CB_STATE_VALUE[to] ?? 0);
    });
  } catch {
    // never throw from instrumentation
  }
}

let _activeGuards = 0;
function incActiveGuards() {
  _activeGuards += 1;
  gauge('siragpt_async_guards_active', {}, _activeGuards);
}
function decActiveGuards() {
  if (_activeGuards > 0) _activeGuards -= 1;
  gauge('siragpt_async_guards_active', {}, _activeGuards);
}
function getActiveGuards() {
  return _activeGuards;
}

function recordAnalyzerCacheStats(prevHits, prevMisses, stats) {
  // Reports DELTAS into the counters. Caller persists prev between calls.
  if (!stats) return { hits: prevHits, misses: prevMisses };
  const hits = Number(stats.hits) || 0;
  const misses = Number(stats.misses) || 0;
  const deltaHits = Math.max(0, hits - (prevHits || 0));
  const deltaMisses = Math.max(0, misses - (prevMisses || 0));
  if (deltaHits) counter('siragpt_analyzer_cache_hits_total', {}, deltaHits);
  if (deltaMisses) counter('siragpt_analyzer_cache_misses_total', {}, deltaMisses);
  return { hits, misses };
}

/**
 * Refresh the `siragpt_org_members_total{orgId}` gauge by counting
 * the current OrgMembership rows for the org. Best-effort: never
 * throws, swallows prisma errors, and no-ops on a missing orgId so
 * callers can wire it straight into mutation paths.
 *
 * @param {object} prismaClient — a Prisma client exposing `orgMembership.count`
 * @param {string} orgId
 * @returns {Promise<number|null>} the freshly observed count, or null on failure
 */
async function refreshOrgMembersGauge(prismaClient, orgId) {
  if (!prismaClient || !orgId || typeof orgId !== 'string') return null;
  try {
    const count = await prismaClient.orgMembership.count({ where: { orgId } });
    const value = Number.isFinite(count) ? Math.max(0, count) : 0;
    gauge('siragpt_org_members_total', { orgId }, value);
    return value;
  } catch {
    // never throw from instrumentation
    return null;
  }
}

/**
 * Refresh the `siragpt_api_keys_active_total` gauge by counting ApiKey
 * rows where `deletedAt IS NULL` AND (`expiresAt IS NULL` OR
 * `expiresAt > now`). Best-effort: never throws, swallows prisma errors,
 * and no-ops on a missing prisma client.
 *
 * Ratchet 44 — wired into the system-cron tick so the gauge tracks
 * the actual live-key count without needing a dedicated scrape hook.
 *
 * @param {object} prismaClient — a Prisma client exposing `apiKey.count`
 * @returns {Promise<number|null>} the freshly observed count, or null on failure
 */
async function refreshActiveApiKeysGauge(prismaClient) {
  if (!prismaClient || !prismaClient.apiKey || typeof prismaClient.apiKey.count !== 'function') {
    return null;
  }
  try {
    const now = new Date();
    const count = await prismaClient.apiKey.count({
      where: {
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    const value = Number.isFinite(count) ? Math.max(0, count) : 0;
    gauge('siragpt_api_keys_active_total', {}, value);
    return value;
  } catch {
    // never throw from instrumentation
    return null;
  }
}

function refreshProcessMetrics() {
  try {
    gauge('siragpt_process_uptime_seconds', {}, Math.round(process.uptime()));
    const mem = process.memoryUsage();
    gauge('siragpt_nodejs_memory_bytes', { type: 'rss' }, mem.rss);
    gauge('siragpt_nodejs_memory_bytes', { type: 'heapUsed' }, mem.heapUsed);
    gauge('siragpt_nodejs_memory_bytes', { type: 'heapTotal' }, mem.heapTotal);
    gauge('siragpt_nodejs_memory_bytes', { type: 'external' }, mem.external || 0);
  } catch {
    // never throw from instrumentation
  }
}

module.exports = {
  registerCounter,
  registerGauge,
  registerHistogram,
  counter,
  gauge,
  observe,
  renderText,
  registry,
  trackCircuitBreaker,
  incActiveGuards,
  decActiveGuards,
  getActiveGuards,
  recordAnalyzerCacheStats,
  recordAIStreamUsage,
  recordGdprExport,
  refreshOrgMembersGauge,
  refreshActiveApiKeysGauge,
  refreshProcessMetrics,
  _reset,
  _clearRegistry,
  CB_STATE_VALUE,
};
