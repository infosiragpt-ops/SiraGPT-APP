'use strict';

/**
 * Ratchet 45 — per-user email notification preferences.
 *
 * User.settings.notifications carries optional opt-out flags for the
 * non-transactional / informational emails the system can send. Each
 * key is a boolean; `false` means "do not send" (opt-out), anything
 * else (including missing) means "send" (default opt-in).
 *
 * Categories
 *   invitations    — org invitation welcome + verification re-send
 *   role_changes   — `sendRoleChangeNotification`
 *   removal        — `sendOrgRemoval`
 *   ownership      — `sendOwnershipTransfer`
 *   billing        — payment failure / subscription / renewal mails
 *   announcements  — org-wide announcement broadcasts (critical severity)
 *   appshots_security — Sira Appshots device-paired / device-revoked
 *                       security notifications. Power users who re-pair
 *                       the extension several times a day can opt out
 *                       here; the audit log entries are unaffected.
 *
 * Verification + invitation acceptance flows are "critical" — they are
 * gated by this helper but ALSO enqueued into the failed-email retry
 * queue when the send throws (see services/failed-email-retry.js).
 *
 * Pure JS; no DB dependency at module load.  Callers pass in a Prisma
 * client (or a `{ notifications }` blob already extracted from
 * `User.settings`) so the helper is trivially mockable in tests.
 */

const VALID_CATEGORIES = Object.freeze([
  'invitations',
  'role_changes',
  'removal',
  'ownership',
  'billing',
  'announcements',
  'appshots_security',
]);

/**
 * Pull the `notifications` sub-object from a User.settings JSON blob.
 * Returns `{}` when missing or non-object so callers can always read
 * keys safely.
 */
function extractNotifications(settings) {
  if (!settings || typeof settings !== 'object') return {};
  const n = settings.notifications;
  if (!n || typeof n !== 'object' || Array.isArray(n)) return {};
  return n;
}

/**
 * Returns true when the user has explicitly opted OUT of `category`.
 * Anything other than the literal `false` value is treated as opt-in
 * (default behaviour preserved for users with no preferences set).
 */
function isOptedOut(notifications, category) {
  if (!VALID_CATEGORIES.includes(category)) return false;
  const n = (notifications && typeof notifications === 'object') ? notifications : {};
  return n[category] === false;
}

/**
 * Load the notifications preferences for a user from Prisma. Returns
 * `{}` on any failure (missing row, missing column, DB error) so the
 * caller can fall back to the opt-in default — losing a single email
 * preference fetch must never block a critical send.
 */
async function loadNotifications(prisma, userId) {
  if (!prisma || !userId) return {};
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { settings: true },
    });
    return extractNotifications(u && u.settings);
  } catch (_) {
    return {};
  }
}

/**
 * Convenience: returns `true` when the email *should* be sent. Loads
 * preferences once and inverts `isOptedOut`. Use this from a fire-and-
 * forget call site to gate `emailService.send*` calls without bloating
 * the email service itself.
 */
async function shouldSendEmail(prisma, userId, category) {
  const notifications = await loadNotifications(prisma, userId);
  return !isOptedOut(notifications, category);
}

/**
 * Merge a partial `notifications` patch into an existing blob. Only
 * known categories are accepted; unknown keys are silently dropped so
 * the API surface stays narrow and a client cannot stuff arbitrary
 * data into the settings JSON via this endpoint.
 *
 * Values are coerced to strict booleans (false → opt-out, true → opt-
 * in). Passing `null` clears the override (back to default opt-in).
 */
function mergeNotificationsPatch(current, patch) {
  const out = { ...(current && typeof current === 'object' ? current : {}) };
  if (!patch || typeof patch !== 'object') return out;
  for (const key of VALID_CATEGORIES) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const v = patch[key];
    if (v === null) {
      delete out[key];
      continue;
    }
    if (typeof v === 'boolean') out[key] = v;
    // Other types silently ignored — keeps the contract strict.
  }
  return out;
}

module.exports = {
  VALID_CATEGORIES,
  extractNotifications,
  isOptedOut,
  loadNotifications,
  shouldSendEmail,
  mergeNotificationsPatch,
};
