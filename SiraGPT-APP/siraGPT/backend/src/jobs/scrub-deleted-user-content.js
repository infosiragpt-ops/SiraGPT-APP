/**
 * scrub-deleted-user-content — GDPR Right-to-be-Forgotten content scrubber.
 *
 * For every User row whose `deletedAt` is set, walk their Messages and
 * Files and overwrite any free-text fields with the PII-masked version.
 * Structure is preserved (ids, timestamps, role, chat membership) so
 * audit trails and analytics-on-shape still work, but the content can
 * no longer be used to re-identify the user.
 *
 * Runs between the soft-delete grace period and the hard-delete cron
 * (`hard-delete-deleted-users.js`). Specifically: candidates are users
 * whose `deletedAt` is at least `SCRUB_AFTER_DAYS` (default 27) old,
 * giving the user a 27-day window to recover their account before the
 * content is irreversibly redacted (and 30 days total before the row
 * itself disappears).
 *
 * Idempotent: scrubbed messages have a metadata flag `piiScrubbed: true`
 * so re-runs skip them. Files get a `processingError` marker (re-use of
 * an existing column to avoid a migration) — that's checked too.
 *
 * Manual usage:
 *   $ node backend/src/jobs/scrub-deleted-user-content.js
 *   $ node backend/src/jobs/scrub-deleted-user-content.js --dry-run
 */

'use strict';

const DEFAULT_SCRUB_DAYS = Number(process.env.GDPR_SCRUB_AFTER_DAYS || 27);
const SCRUB_MARKER = '[PII scrubbed by GDPR job]';

// Metrics are loaded lazily so this module stays importable in test
// contexts that stub Prisma without booting the metrics registry.
function _bumpScrubCounter(kind, delta) {
  if (!delta) return;
  try {
    // eslint-disable-next-line global-require
    const metrics = require('../utils/metrics');
    if (metrics && typeof metrics.counter === 'function') {
      metrics.counter('siragpt_gdpr_content_scrubbed_total', { kind }, delta);
    }
  } catch { /* metrics are best-effort */ }
}

/**
 * @param {{
 *   prisma?: import('@prisma/client').PrismaClient,
 *   dryRun?: boolean,
 *   scrubAfterDays?: number,
 *   now?: Date,
 *   logger?: { info: Function, warn: Function, error: Function },
 *   piiMask?: { mask: Function },
 * }} [opts]
 */
async function run(opts = {}) {
  const logger = opts.logger || console;
  const prisma = opts.prisma || require('../config/database');
  const piiMask = opts.piiMask || require('../utils/pii-mask');
  const scrubAfterDays = Number.isFinite(opts.scrubAfterDays)
    ? Number(opts.scrubAfterDays)
    : DEFAULT_SCRUB_DAYS;
  const dryRun = Boolean(opts.dryRun);
  const now = opts.now instanceof Date ? opts.now : new Date();
  const cutoff = new Date(now.getTime() - scrubAfterDays * 24 * 60 * 60 * 1000);

  logger.info(
    `[scrub-pii] starting cutoff=${cutoff.toISOString()} scrubAfterDays=${scrubAfterDays} dryRun=${dryRun}`,
  );

  const users = await prisma.user.findMany({
    where: { deletedAt: { lt: cutoff, not: null } },
    select: { id: true, email: true, deletedAt: true },
  });

  if (users.length === 0) {
    logger.info('[scrub-pii] no soft-deleted users past the scrub window');
    return { users: 0, messages: 0, files: 0, dryRun };
  }

  logger.info(`[scrub-pii] candidates=${users.length}`);

  let totalMessages = 0;
  let totalFiles = 0;

  for (const u of users) {
    // ── Messages ──
    // Pull the user's chats, then their messages. We scrub only those
    // not yet marked as scrubbed.
    const chats = await prisma.chat.findMany({
      where: { userId: u.id },
      select: { id: true },
    });
    const chatIds = chats.map((c) => c.id);

    if (chatIds.length > 0) {
      const messages = await prisma.message.findMany({
        where: { chatId: { in: chatIds } },
        select: { id: true, content: true, metadata: true },
      });

      for (const m of messages) {
        const meta = (m.metadata && typeof m.metadata === 'object') ? m.metadata : {};
        if (meta.piiScrubbed === true) continue; // already done

        const original = typeof m.content === 'string' ? m.content : '';
        const masked = original ? piiMask.mask(original) : original;
        // Always set the scrubbed flag so re-runs are stable, even if
        // the content didn't contain detectable PII.
        const newMeta = { ...meta, piiScrubbed: true, piiScrubbedAt: now.toISOString() };

        if (dryRun) {
          totalMessages++;
          continue;
        }
        try {
          await prisma.message.update({
            where: { id: m.id },
            data: { content: masked, metadata: newMeta },
          });
          totalMessages++;
          _bumpScrubCounter('message', 1);
        } catch (err) {
          logger.warn(`[scrub-pii] message=${m.id} update failed: ${err?.message || err}`);
        }
      }
    }

    // ── Files ──
    // File rows themselves don't get deleted (that's the hard-delete
    // job's job), but we redact the originalName + filename + extracted
    // text so they no longer carry PII.
    const files = await prisma.file.findMany({
      where: { userId: u.id },
      select: { id: true, filename: true, originalName: true, extractedText: true, processingError: true },
    });

    for (const f of files) {
      if (f.processingError && f.processingError.includes(SCRUB_MARKER)) continue;
      const data = {};
      if (typeof f.originalName === 'string') data.originalName = piiMask.mask(f.originalName);
      if (typeof f.filename === 'string') data.filename = piiMask.mask(f.filename);
      if (typeof f.extractedText === 'string' && f.extractedText.length > 0) {
        data.extractedText = piiMask.mask(f.extractedText);
      }
      data.processingError = SCRUB_MARKER;

      if (dryRun) {
        totalFiles++;
        continue;
      }
      try {
        await prisma.file.update({ where: { id: f.id }, data });
        totalFiles++;
        _bumpScrubCounter('file', 1);
      } catch (err) {
        logger.warn(`[scrub-pii] file=${f.id} update failed: ${err?.message || err}`);
      }
    }

    // Best-effort audit row per scrubbed user.
    try {
      const { writeAuditLog } = require('../utils/audit-log');
      if (writeAuditLog && !dryRun) {
        await writeAuditLog(prisma, {
          action: 'user_pii_scrub',
          actorType: 'system',
          resource: 'user',
          resourceId: u.id,
          metadata: { email: u.email, messages: totalMessages, files: totalFiles },
        });
      }
    } catch (_) { /* audit failures must never block the scrub */ }
  }

  logger.info(`[scrub-pii] done users=${users.length} messages=${totalMessages} files=${totalFiles}`);
  return { users: users.length, messages: totalMessages, files: totalFiles, dryRun };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then((res) => {
      console.log('[scrub-pii] result:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[scrub-pii] fatal:', err);
      process.exit(1);
    });
}

module.exports = { run, SCRUB_MARKER };
