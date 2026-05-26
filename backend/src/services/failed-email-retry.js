'use strict';

/**
 * Ratchet 45 — failed-email retry queue.
 *
 * Email sends in this codebase are fire-and-forget — if the SMTP
 * transporter throws or returns a transient error, the message is lost.
 * For "critical" notifications (org-invitation welcome + email-
 * verification magic link) we need at-least-some-effort delivery,
 * otherwise a transient outage silently breaks onboarding.
 *
 * This module owns a very small persistent retry queue, backed by the
 * existing `SystemSettings` key/value table so we don't have to add a
 * schema migration:
 *
 *   key   = `failed_email_retry:<id>` (id is a hex token, unique)
 *   value = JSON.stringify({
 *             kind: 'invitation' | 'verification',
 *             payload: { ... },              // kind-specific
 *             attempts: number,              // 0…MAX_ATTEMPTS
 *             firstFailedAt: ISO string,
 *             lastAttemptAt: ISO string|null,
 *             lastError: string|null,
 *           })
 *
 * A nightly cron at 06:00 UTC drains the queue: each row is retried
 * once per pass. After `MAX_ATTEMPTS` total attempts (including the
 * original failed send) the row is dropped — operators can grep the
 * audit log for the entry and intervene manually.
 *
 * The send paths are kept dependency-free: `enqueueIfFailed(...)`
 * wraps a single send promise, catches a rejection, and persists it.
 * The cron handler imports `runRetryPass` which reads every retry row
 * and asks `emailService` to redeliver.
 *
 * Pure JS; safe to load when SMTP/Prisma are unconfigured (every entry
 * point degrades into a no-op so callers stay fire-and-forget).
 */

const crypto = require('node:crypto');

const KEY_PREFIX = 'failed_email_retry:';
const MAX_ATTEMPTS = 3;
const VALID_KINDS = Object.freeze(['invitation', 'verification']);

function _id() {
  return crypto.randomBytes(12).toString('hex');
}

function _isValidKind(kind) {
  return VALID_KINDS.includes(kind);
}

/**
 * Persist a fresh retry row. `payload` is kind-specific:
 *
 *   invitation   → { user: { email, name }, org: { id, name, slug } }
 *   verification → { user: { email, name }, token: string }
 *
 * Returns the new row id, or null when persistence fails (best effort).
 */
async function enqueue(prisma, kind, payload) {
  if (!prisma || !prisma.systemSettings || !_isValidKind(kind)) return null;
  const id = _id();
  const key = `${KEY_PREFIX}${id}`;
  const value = JSON.stringify({
    kind,
    payload: payload || {},
    attempts: 0,
    firstFailedAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastError: null,
  });
  try {
    await prisma.systemSettings.create({ data: { key, value } });
    return id;
  } catch (_) {
    // Best-effort persistence — never throw into the send caller.
    return null;
  }
}

/**
 * Wrap a fire-and-forget send promise. If the promise rejects (or
 * resolves to an explicit `false` — some `send*` helpers return that
 * sentinel when SMTP is unconfigured), the payload is queued for the
 * cron pass. SMTP-unconfigured rejections are *not* queued — there is
 * nothing to retry until the operator wires SMTP up again, and queuing
 * would flood SystemSettings during boot in dev.
 *
 * `kind` and `payload` map 1:1 to `enqueue`.
 */
async function enqueueIfFailed(prisma, kind, payload, sendPromise, opts = {}) {
  try {
    const result = await sendPromise;
    // Several email helpers return `false` to signal "SMTP not configured
    // — no transporter hand-off". Treat that as not-actually-failed so we
    // don't pile up retry rows during local dev / unconfigured envs.
    if (result === false && opts.queueOnSmtpDisabled !== true) return false;
    return true;
  } catch (err) {
    await enqueue(prisma, kind, payload);
    return false;
  }
}

/**
 * List every retry row. Returns an array of `{ id, key, ...parsed }`
 * objects; malformed rows are skipped and dropped from the table so
 * the queue self-heals.
 */
async function _listRows(prisma) {
  if (!prisma || !prisma.systemSettings) return [];
  let rows;
  try {
    rows = await prisma.systemSettings.findMany({
      where: { key: { startsWith: KEY_PREFIX } },
    });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const r of rows) {
    let parsed = null;
    try { parsed = JSON.parse(r.value); } catch (_) { parsed = null; }
    if (!parsed || !_isValidKind(parsed.kind)) {
      try { await prisma.systemSettings.delete({ where: { key: r.key } }); } catch (_) {}
      continue;
    }
    const id = r.key.slice(KEY_PREFIX.length);
    out.push({ id, key: r.key, ...parsed });
  }
  return out;
}

/**
 * Drain the retry queue once. For every row we try to re-deliver and
 * either drop the row (on success) or bump `attempts` (on another
 * failure). Rows that hit `MAX_ATTEMPTS` are dropped — the audit
 * trail in the original failure log is the operator's hook.
 *
 * Returns a `{ scanned, redelivered, dropped, requeued }` summary so
 * the cron handler can log per-run telemetry.
 */
async function runRetryPass(deps = {}) {
  const prisma = deps.prisma || require('../config/database');
  const emailService = deps.emailService || require('./email');
  const logger = deps.logger || console;

  if (!prisma || !prisma.systemSettings) {
    return { scanned: 0, redelivered: 0, dropped: 0, requeued: 0 };
  }

  // Skip the whole pass when SMTP is unconfigured — rows would just
  // immediately fail again. Keep them in the table for the next run.
  if (emailService.isConfigured && !emailService.isConfigured()) {
    logger.info?.('[failed-email-retry] skip pass — SMTP not configured');
    return { scanned: 0, redelivered: 0, dropped: 0, requeued: 0 };
  }

  const rows = await _listRows(prisma);
  let redelivered = 0;
  let dropped = 0;
  let requeued = 0;

  for (const row of rows) {
    const nextAttempts = (Number(row.attempts) || 0) + 1;
    let ok = false;
    let errMsg = null;

    try {
      if (row.kind === 'invitation') {
        const user = row.payload && row.payload.user;
        const org = row.payload && row.payload.org;
        if (!user || !user.email) throw new Error('missing user.email');
        const r = await emailService.sendOrgWelcome(user, org || {});
        ok = r !== false;
      } else if (row.kind === 'verification') {
        const user = row.payload && row.payload.user;
        const token = row.payload && row.payload.token;
        if (!user || !user.email || !token) throw new Error('missing user.email or token');
        await emailService.sendEmailVerification(user, token);
        ok = true;
      } else {
        throw new Error(`unknown kind ${row.kind}`);
      }
    } catch (err) {
      ok = false;
      errMsg = err && err.message ? err.message : String(err);
    }

    if (ok) {
      try { await prisma.systemSettings.delete({ where: { key: row.key } }); } catch (_) {}
      redelivered += 1;
      continue;
    }

    if (nextAttempts >= MAX_ATTEMPTS) {
      try { await prisma.systemSettings.delete({ where: { key: row.key } }); } catch (_) {}
      dropped += 1;
      logger.warn?.(
        `[failed-email-retry] dropped ${row.kind} retry ${row.id} after `
        + `${nextAttempts} attempts: ${errMsg || 'unknown error'}`,
      );
      continue;
    }

    // Bump attempts and persist the new state.
    try {
      await prisma.systemSettings.update({
        where: { key: row.key },
        data: {
          value: JSON.stringify({
            kind: row.kind,
            payload: row.payload,
            attempts: nextAttempts,
            firstFailedAt: row.firstFailedAt,
            lastAttemptAt: new Date().toISOString(),
            lastError: errMsg,
          }),
        },
      });
      requeued += 1;
    } catch (_) {
      // Persistence failed — leave the row alone; next pass will pick it up.
    }
  }

  logger.info?.(
    `[failed-email-retry] pass done: scanned=${rows.length} `
    + `redelivered=${redelivered} dropped=${dropped} requeued=${requeued}`,
  );

  return { scanned: rows.length, redelivered, dropped, requeued };
}

module.exports = {
  KEY_PREFIX,
  MAX_ATTEMPTS,
  VALID_KINDS,
  enqueue,
  enqueueIfFailed,
  runRetryPass,
  _listRows, // exported for tests
};

// Cron entry point — symmetry with other src/jobs modules so
// system-cron.js can `require('./failed-email-retry')` directly when
// we want it to live under jobs/ too. Exported as `run` to match the
// existing job convention (`{ run({ logger }) }`).
module.exports.run = function run(opts = {}) {
  return runRetryPass(opts);
};
