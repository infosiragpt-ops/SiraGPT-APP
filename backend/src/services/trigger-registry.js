'use strict';

/**
 * trigger-registry — Zapier-style event publisher.
 *
 * Backend code calls `triggers.publish(event, payload, userId)`; the
 * registry fans out to:
 *   1. all user-owned WebhookEndpoints subscribed to `event` (or '*')
 *   2. the user's SlackIntegration if isEnabled
 *
 * Idempotency: a SHA-256 hash of (event + userId + JSON.stringify(payload))
 * is kept in a bounded LRU; duplicate calls within the TTL are skipped so
 * a retried POST doesn't double-fire downstream effects.
 *
 * Debounce: `publishDebounced` collapses bursts of events with the same
 * dedupeKey into a single trailing-edge dispatch (used for
 * `chat.message_sent` to avoid streaming a webhook per token-save).
 *
 * Public API:
 *   TRIGGERS                                    → string[]
 *   isKnownTrigger(name)                        → boolean
 *   publish(event, payload, userId, opts?)      → Promise<{ dispatched, deduped, errors }>
 *   publishDebounced(event, payload, userId, opts) → Promise<void>
 *   resetForTests()                             → void  (clears caches + timers)
 *   __setPrisma(client) / __setDispatcher(fn) / __setSlackSender(fn)  → DI for tests
 */

const crypto = require('crypto');

const TRIGGERS = Object.freeze([
  'chat.created',
  'chat.message_sent',
  'chat.archived',
  'chat.completed',
  'payment.succeeded',
  'payment.failed',
  'payment.received',
  'file.uploaded',
  'agent.task.completed',
  'org.invitation.created',
  'org.invitation.accepted',
  'org.invitation.revoked',
  'org.announcement.created',
  'org.announcement.acknowledged',
  'org.member.role_changed',
]);

const KNOWN_SET = new Set(TRIGGERS);

const DEFAULT_IDEMPOTENCY_TTL_MS = 60_000;
const DEFAULT_LRU_SIZE = 512;

// ── Event glob matcher (ratchet 45, Task 1) ──────────────────────────
// WebhookEndpoint.events entries may be:
//   - the literal '*' (subscribe to everything — legacy behaviour)
//   - an exact event name (e.g. 'org.invitation.created')
//   - a glob with '*' wildcards matching any run of non-dot OR dot
//     characters between dots, e.g. 'org.invitation.*' matches all
//     three lifecycle events but NOT 'org.member.created'.
//     'chat.*' matches 'chat.created' / 'chat.message_sent' / etc.
//     '*.created' matches every '*.created' tail.
// A trailing '.**' (double-star) explicitly allows multi-segment tails
// — kept for forwards compatibility but currently equivalent to '.*'
// because all known triggers have a single segment after the prefix.
//
// Compiled regexes are cached per pattern to keep the per-publish hot
// path allocation-free for repeated subscribers.
const _globCache = new Map();
function _compileGlob(pattern) {
  if (_globCache.has(pattern)) return _globCache.get(pattern);
  // Escape regex metacharacters except '*', then translate '*' tokens.
  // Sequence order matters: handle '**' before single '*'.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '^' + escaped.replace(/\*\*/g, '::DOUBLESTAR::').replace(/\*/g, '[^.]*').replace(/::DOUBLESTAR::/g, '.*') + '$',
  );
  _globCache.set(pattern, re);
  return re;
}

function eventMatches(pattern, event) {
  if (typeof pattern !== 'string' || typeof event !== 'string') return false;
  if (pattern === '*' || pattern === '**') return true;
  if (pattern === event) return true;
  // Fast-reject: no glob char → must be an exact match (already failed).
  if (!pattern.includes('*')) return false;
  return _compileGlob(pattern).test(event);
}

function endpointMatchesEvent(endpoint, event) {
  const events = Array.isArray(endpoint && endpoint.events) ? endpoint.events : [];
  for (const p of events) {
    if (eventMatches(p, event)) return true;
  }
  return false;
}

let prismaRef = null;
function getPrisma() {
  if (prismaRef) return prismaRef;
  try { prismaRef = require('../config/database'); } catch { prismaRef = null; }
  return prismaRef;
}
function __setPrisma(p) { prismaRef = p; }

let dispatcherRef = null;
function getDispatcher() {
  if (dispatcherRef) return dispatcherRef;
  try { dispatcherRef = require('./webhook-dispatcher'); } catch { dispatcherRef = null; }
  return dispatcherRef;
}
function __setDispatcher(d) { dispatcherRef = d; }

// ── Unknown-event metric (ratchet 45, Task 1) ────────────────────────
// publish() rejects events that aren't in TRIGGERS to keep the fan-out
// surface tight; each rejection bumps siragpt_unknown_trigger_total{event}
// so ops can spot typos or stale call sites. Metric module load is
// best-effort — test environments without it keep working.
let _metricsRef = null;
function _getMetrics() {
  if (_metricsRef !== null) return _metricsRef;
  try {
    // eslint-disable-next-line global-require
    const m = require('../utils/metrics');
    if (m && typeof m.registerCounter === 'function') {
      m.registerCounter('siragpt_unknown_trigger_total', {
        help: 'Total publish() calls rejected because the event is not in the TRIGGERS allow-list',
        labels: ['event'],
      });
    }
    _metricsRef = m;
  } catch { _metricsRef = false; }
  return _metricsRef;
}

function _trackUnknownTrigger(event) {
  const m = _getMetrics();
  if (!m || typeof m.counter !== 'function') return;
  try { m.counter('siragpt_unknown_trigger_total', { event: String(event || 'unknown') }, 1); }
  catch { /* never break the publisher */ }
}

let slackSenderRef = null;
function getSlackSender() {
  if (slackSenderRef) return slackSenderRef;
  try {
    const slack = require('./slack-integration');
    slackSenderRef = slack;
  } catch { slackSenderRef = null; }
  return slackSenderRef;
}
function __setSlackSender(fn) { slackSenderRef = fn; }

// ---------------- idempotency LRU ----------------
const idemLru = new Map(); // hash → expiresAt

function eventHash(event, userId, payload) {
  const body = JSON.stringify({ event, userId: userId || null, payload: payload ?? null });
  return crypto.createHash('sha256').update(body).digest('hex');
}

function isDuplicate(hash, now, ttlMs) {
  const exp = idemLru.get(hash);
  if (exp && exp > now) return true;
  // refresh LRU position
  idemLru.delete(hash);
  idemLru.set(hash, now + ttlMs);
  if (idemLru.size > DEFAULT_LRU_SIZE) {
    const oldestKey = idemLru.keys().next().value;
    if (oldestKey !== undefined) idemLru.delete(oldestKey);
  }
  return false;
}

// ---------------- debounce ----------------
const debounceTimers = new Map(); // key → { timer, latestArgs }

function publishDebounced(event, payload, userId, opts = {}) {
  const delayMs = Number(opts.delayMs) > 0 ? Number(opts.delayMs) : 1000;
  const dedupeKey = opts.dedupeKey || `${event}:${userId}`;
  const existing = debounceTimers.get(dedupeKey);
  return new Promise((resolve) => {
    if (existing) {
      // Replace the pending dispatch with the latest args; resolve the
      // caller immediately (debounced means "fire-and-forget collapse").
      clearTimeout(existing.timer);
      existing.waiters.push(resolve);
      const timer = setTimeout(() => fire(dedupeKey), delayMs);
      if (typeof timer.unref === 'function') timer.unref();
      existing.timer = timer;
      existing.latestArgs = { event, payload, userId };
      existing.opts = opts;
      // Resolve the previous waiter immediately — it was collapsed.
      // The new caller waits for the trailing dispatch.
      return;
    }
    const entry = { timer: null, latestArgs: { event, payload, userId }, opts, waiters: [resolve] };
    const timer = setTimeout(() => fire(dedupeKey), delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    entry.timer = timer;
    debounceTimers.set(dedupeKey, entry);
  });
}

async function fire(dedupeKey) {
  const entry = debounceTimers.get(dedupeKey);
  if (!entry) return;
  debounceTimers.delete(dedupeKey);
  const { latestArgs, opts, waiters } = entry;
  try {
    await publish(latestArgs.event, latestArgs.payload, latestArgs.userId, opts);
  } catch {
    // swallow — debounced publish is fire-and-forget
  } finally {
    for (const w of waiters) {
      try { w(); } catch { /* noop */ }
    }
  }
}

// ---------------- main publish ----------------
async function publish(event, payload, userId, opts = {}) {
  if (typeof event !== 'string' || !event) throw new Error('event required');
  // Ratchet 45, Task 1 — reject events that aren't in the canonical
  // TRIGGERS allow-list. Strict mode (default) throws so callers learn
  // about typos immediately; opt-in lenient mode (`opts.allowUnknown`)
  // emits a console.warn + no-op so legacy call sites don't blow up
  // during rollout. Both paths bump siragpt_unknown_trigger_total.
  if (!KNOWN_SET.has(event)) {
    _trackUnknownTrigger(event);
    if (opts && opts.allowUnknown) {
      // eslint-disable-next-line no-console
      console.warn(`[trigger-registry] dropping unknown event: ${event}`);
      return { dispatched: 0, deduped: false, errors: [], unknown: true };
    }
    throw new Error(`unknown trigger event: ${event}`);
  }
  const ttlMs = Number(opts.idempotencyTtlMs) > 0 ? Number(opts.idempotencyTtlMs) : DEFAULT_IDEMPOTENCY_TTL_MS;
  const now = Date.now();
  const hash = eventHash(event, userId, payload);
  if (isDuplicate(hash, now, ttlMs)) {
    return { dispatched: 0, deduped: true, errors: [] };
  }

  let dispatched = 0;
  const errors = [];

  // --- 0. In-app notification inbox (ratchet 45, Task 1)
  // Persist a Notification row for events that surface in the user
  // inbox UI. Best-effort: failures must not abort webhook/Slack
  // fan-out. Lazy-required so test envs that stub the registry don't
  // pull in Prisma.
  try {
    const prismaForInbox = getPrisma();
    if (prismaForInbox) {
      // eslint-disable-next-line global-require
      const notifier = require('./user-notifications');
      // Fire-and-forget — we surface errors as `errors[]` entries but
      // never throw out of publish().
      await notifier.handleTriggerEvent(prismaForInbox, event, payload, userId);
    }
  } catch (err) {
    errors.push({ stage: 'user-notifications', message: err?.message || String(err) });
  }

  // --- 1. Fan out to WebhookEndpoints (user + org scopes)
  //
  // Cycle 45: in addition to the per-user fan-out, we also fan out to
  // org-scoped endpoints when the publishing payload carries an `orgId`
  // (or `organizationId`). Endpoints already targeting the same row by
  // id are de-duplicated so an admin who created an endpoint as
  // {userId, orgId} doesn't receive it twice.
  const prisma = getPrisma();
  const dispatcher = getDispatcher();
  const orgId = payload && typeof payload === 'object'
    ? (payload.orgId || payload.organizationId || null)
    : null;

  const endpointsById = new Map();
  if (prisma && prisma.webhookEndpoint) {
    if (userId) {
      try {
        const rows = await prisma.webhookEndpoint.findMany({
          where: { userId, isActive: true },
        });
        for (const r of rows) endpointsById.set(r.id, r);
      } catch (err) {
        errors.push({ stage: 'prisma.webhookEndpoint.findMany', message: err?.message || String(err) });
      }
    }
    if (orgId) {
      try {
        const rows = await prisma.webhookEndpoint.findMany({
          where: { organizationId: orgId, isActive: true },
        });
        for (const r of rows) if (!endpointsById.has(r.id)) endpointsById.set(r.id, r);
      } catch (err) {
        errors.push({ stage: 'prisma.webhookEndpoint.findMany.org', message: err?.message || String(err) });
      }
    }
  }
  const endpoints = [...endpointsById.values()];

  for (const ep of endpoints) {
    if (!endpointMatchesEvent(ep, event)) continue;
    if (!dispatcher || typeof dispatcher.dispatch !== 'function') break;
    try {
      const result = await dispatcher.dispatch({
        url: ep.url,
        event,
        payload: { event, userId, orgId: ep.organizationId || orgId || null, data: payload, ts: now },
        secret: ep.secret,
      });
      dispatched += 1;
      if (prisma && ep.id) {
        prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: { lastDeliveryAt: new Date() },
        }).catch(() => {});
      }
      if (result?.status === 'failed') {
        errors.push({ stage: 'webhook', endpointId: ep.id, message: result.error });
      }
    } catch (err) {
      errors.push({ stage: 'webhook', endpointId: ep.id, message: err?.message || String(err) });
    }
  }

  // --- 2. Slack integration (best-effort, opt-in)
  //
  // Cycle 45: prefer the org-scoped Slack integration when the payload
  // carries an orgId — org-wide notifications should land in the team
  // channel, not in the publishing user's DM webhook. Falls back to the
  // per-user integration when no org integration exists.
  if (prisma && prisma.slackIntegration) {
    try {
      let slack = null;
      if (orgId) {
        slack = await prisma.slackIntegration.findFirst({
          where: { organizationId: orgId, isEnabled: true },
        });
      }
      if (!slack && userId) {
        slack = await prisma.slackIntegration.findFirst({
          where: { userId, isEnabled: true },
        });
      }
      if (slack && slack.webhookUrl) {
        const slackSender = getSlackSender();
        if (slackSender && typeof slackSender.sendEventNotification === 'function') {
          await slackSender.sendEventNotification({
            webhookUrl: slack.webhookUrl,
            event,
            userId,
            payload,
          });
          dispatched += 1;
        }
      }
    } catch (err) {
      errors.push({ stage: 'slack', message: err?.message || String(err) });
    }
  }

  return { dispatched, deduped: false, errors };
}

function isKnownTrigger(name) { return KNOWN_SET.has(name); }

function resetForTests() {
  idemLru.clear();
  for (const entry of debounceTimers.values()) {
    clearTimeout(entry.timer);
    if (Array.isArray(entry.waiters)) {
      for (const w of entry.waiters) {
        try { w(); } catch { /* noop */ }
      }
    }
  }
  debounceTimers.clear();
  prismaRef = null;
  dispatcherRef = null;
  slackSenderRef = null;
  _metricsRef = null;
}

module.exports = {
  TRIGGERS,
  isKnownTrigger,
  publish,
  publishDebounced,
  resetForTests,
  __setPrisma,
  __setDispatcher,
  __setSlackSender,
  // exposed for tests
  _eventHash: eventHash,
  eventMatches,
  endpointMatchesEvent,
};
