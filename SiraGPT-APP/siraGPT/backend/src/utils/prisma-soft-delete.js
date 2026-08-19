/**
 * prisma-soft-delete — opt-in helpers for the soft-delete framework
 * introduced in improvement cycle 14.
 *
 * Why opt-in (not a global Prisma client extension):
 *   - A global `where: { deletedAt: null }` injection breaks admin /
 *     audit / hard-delete-cron flows that explicitly need to see
 *     tombstoned rows. Past experience with the v3 client middleware
 *     showed that "default-hidden" rows leak through batch jobs and
 *     reporting in surprising ways.
 *   - Callers that want the filter use `softDeleteWhere(extra)` to
 *     compose it onto their query; the rest of the codebase stays
 *     untouched and behaves exactly as before.
 *
 * Supported models — the columns are documented in
 * `backend/prisma/schema.prisma` and the migration
 * `20260519010000_add_soft_delete_fields`:
 *   - User, Chat (pre-existing), Message, File, Project, CustomGpt
 *
 * Usage:
 *   const { softDeleteWhere, softDelete } = require('../utils/prisma-soft-delete');
 *
 *   // List alive projects for a user:
 *   prisma.project.findMany({ where: softDeleteWhere({ userId }) });
 *
 *   // Mark a chat as deleted (without removing it):
 *   await softDelete(prisma.chat, { id: chatId });
 *
 *   // Restore:
 *   await softDelete(prisma.chat, { id: chatId }, { restore: true });
 */

'use strict';

const SOFT_DELETE_MODELS = Object.freeze([
  'user',
  'chat',
  'message',
  'file',
  'project',
  'customGpt',
]);

/**
 * Compose a Prisma `where` clause that excludes soft-deleted rows.
 *
 * Pass any additional filters as `extra`; they're merged on top of
 * `{ deletedAt: null }`. The caller is responsible for AND/OR shape —
 * keep it simple: pass a plain object, get a plain object back.
 *
 * @param {object} [extra]
 * @returns {object}
 */
function softDeleteWhere(extra) {
  if (extra == null) return { deletedAt: null };
  if (typeof extra !== 'object' || Array.isArray(extra)) {
    throw new TypeError('softDeleteWhere(extra): extra must be a plain object');
  }
  // If the caller already set `deletedAt`, respect their intent (e.g.
  // `{ deletedAt: { not: null } }` for "show only trash").
  if (Object.prototype.hasOwnProperty.call(extra, 'deletedAt')) return { ...extra };
  return { ...extra, deletedAt: null };
}

/**
 * Apply (or undo) a soft delete on the given Prisma delegate. Returns
 * the updated row(s) from Prisma. Uses `updateMany` so the caller can
 * pass any uniqueness filter (id, composite, etc.) without first
 * resolving it.
 *
 * @param {{ updateMany: Function }} delegate — e.g. prisma.chat
 * @param {object} where — Prisma where clause
 * @param {{ restore?: boolean, deletedAt?: Date }} [opts]
 */
async function softDelete(delegate, where, opts = {}) {
  if (!delegate || typeof delegate.updateMany !== 'function') {
    throw new TypeError('softDelete: invalid Prisma delegate');
  }
  const data = opts.restore
    ? { deletedAt: null }
    : { deletedAt: opts.deletedAt || new Date() };
  return delegate.updateMany({ where, data });
}

/**
 * Convenience: cascade a soft-delete across a user's owned rows. Used
 * by `POST /api/users/me/delete` to wipe the visible surface without
 * doing a hard delete. Each operation is wrapped in a try so a single
 * table failing (e.g. a future model that doesn't have deletedAt yet)
 * doesn't strand the rest.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} userId
 */
async function cascadeSoftDeleteForUser(prisma, userId) {
  if (!prisma || !userId) throw new TypeError('cascadeSoftDeleteForUser: prisma + userId required');
  const now = new Date();
  const results = {};
  const ops = [
    ['chats', () => prisma.chat.updateMany({ where: { userId, deletedAt: null }, data: { deletedAt: now } })],
    ['files', () => prisma.file.updateMany({ where: { userId, deletedAt: null }, data: { deletedAt: now } })],
    ['projects', () => prisma.project.updateMany({ where: { userId, deletedAt: null }, data: { deletedAt: now } })],
    ['customGpts', () => prisma.customGpt.updateMany({ where: { creatorId: userId, deletedAt: null }, data: { deletedAt: now } })],
    // Messages cascade via chat.userId; updateMany supports nested
    // relation filters in Prisma.
    ['messages', () => prisma.message.updateMany({ where: { chat: { userId }, deletedAt: null }, data: { deletedAt: now } })],
  ];
  for (const [name, fn] of ops) {
    try {
      const r = await fn();
      results[name] = r?.count ?? 0;
    } catch (err) {
      results[name] = { error: err?.message || String(err) };
    }
  }
  return results;
}

module.exports = {
  SOFT_DELETE_MODELS,
  softDeleteWhere,
  softDelete,
  cascadeSoftDeleteForUser,
};
