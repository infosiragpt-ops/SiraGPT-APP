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
]);

const KNOWN_SET = new Set(TRIGGERS);

const DEFAULT_IDEMPOTENCY_TTL_MS = 60_000;
const DEFAULT_LRU_SIZE = 512;

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
  const ttlMs = Number(opts.idempotencyTtlMs) > 0 ? Number(opts.idempotencyTtlMs) : DEFAULT_IDEMPOTENCY_TTL_MS;
  const now = Date.now();
  const hash = eventHash(event, userId, payload);
  if (isDuplicate(hash, now, ttlMs)) {
    return { dispatched: 0, deduped: true, errors: [] };
  }

  let dispatched = 0;
  const errors = [];

  // --- 1. Fan out to WebhookEndpoints
  const prisma = getPrisma();
  const dispatcher = getDispatcher();
  let endpoints = [];
  if (prisma && prisma.webhookEndpoint && userId) {
    try {
      endpoints = await prisma.webhookEndpoint.findMany({
        where: { userId, isActive: true },
      });
    } catch (err) {
      errors.push({ stage: 'prisma.webhookEndpoint.findMany', message: err?.message || String(err) });
    }
  }

  for (const ep of endpoints) {
    const events = Array.isArray(ep.events) ? ep.events : [];
    if (!events.includes(event) && !events.includes('*')) continue;
    if (!dispatcher || typeof dispatcher.dispatch !== 'function') break;
    try {
      const result = await dispatcher.dispatch({
        url: ep.url,
        event,
        payload: { event, userId, data: payload, ts: now },
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
  if (prisma && prisma.slackIntegration && userId) {
    try {
      const slack = await prisma.slackIntegration.findFirst({
        where: { userId, isEnabled: true },
      });
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
};
