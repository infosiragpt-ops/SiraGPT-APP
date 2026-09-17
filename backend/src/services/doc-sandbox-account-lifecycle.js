'use strict';

const { randomUUID } = require('node:crypto');

/** Runs inside the account lifecycle transaction, after locking/deactivating the
 * user. No external deletion happens here: the durable cleanup worker owns it. */
async function prepareDocumentAccountDeletion(tx, userId, { purge = false } = {}) {
  const presence = await tx.$queryRawUnsafe("SELECT to_regclass('doc_jobs')::text AS relation");
  if (!Array.isArray(presence) || !presence[0] || !Object.hasOwn(presence[0], 'relation')) {
    throw new Error('DOC_ACCOUNT_SCHEMA_UNAVAILABLE');
  }
  // Supports installations/rollback before the additive document migration.
  if (presence[0].relation === null) return { pending: false, revoked: 0, purged: 0 };
  const rows = await tx.$queryRawUnsafe('SELECT * FROM doc_jobs WHERE user_id=$1 ORDER BY id FOR UPDATE', userId);
  if (purge && rows.length) await tx.$executeRawUnsafe('UPDATE doc_jobs SET account_purge_requested=true WHERE user_id=$1', userId);
  let revoked = 0;
  for (const row of rows) {
    if (row.deleted_at) continue;
    await tx.$executeRawUnsafe(`UPDATE doc_jobs SET
      status=CASE WHEN status IN ('done','failed','cancelled') THEN status ELSE 'cancelled' END,
      deleted_at=clock_timestamp(),fence=fence+1,lease_token=NULL,lease_expires_at=NULL,
      finished_at=COALESCE(finished_at,clock_timestamp()),cleanup_pending=true,
      cleanup_not_before=GREATEST(COALESCE(cleanup_not_before,clock_timestamp()),clock_timestamp()+interval '15 minutes'),
      purged_keys=ARRAY[]::text[],event_seq=event_seq+1,updated_at=clock_timestamp()
      WHERE id=$1`, row.id);
    await tx.$executeRawUnsafe('UPDATE doc_job_artifacts SET published=false,purged_at=NULL WHERE job_id=$1', row.id);
    await tx.$executeRawUnsafe(`INSERT INTO doc_job_events(id,job_id,seq,type,payload,outbox)
      SELECT $1,id,event_seq,'deleted',jsonb_build_object('status',status,'code','DOC_ACCOUNT_DELETED'),'cleanup'
      FROM doc_jobs WHERE id=$2`, randomUUID(), row.id);
    revoked++;
  }
  if (!purge || revoked) return { pending: rows.length > 0, revoked, purged: 0 };
  // Recheck durable evidence, not only a mutable cleanup_pending boolean. Unknown
  // billing/container lifetime remains a blocker; original bytes are never dropped
  // through a cascading FK merely because an account requested deletion.
  const remaining = await tx.$queryRawUnsafe(`SELECT count(*)::int AS count FROM doc_jobs j WHERE user_id=$1 AND (
    deleted_at IS NULL OR cleanup_pending=true OR lease_token IS NOT NULL OR quota_settled_at IS NULL OR
    cleanup_not_before>clock_timestamp() OR NOT (storage_keys <@ purged_keys) OR
    EXISTS(SELECT 1 FROM doc_job_artifacts a WHERE a.job_id=j.id AND a.purged_at IS NULL) OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(provider_files) f WHERE (f->>'deleted') IS DISTINCT FROM 'true') OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(provider_containers) c WHERE c->>'expiresAt' IS NULL OR (c->>'expiresAt')::timestamptz>clock_timestamp()) OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(cost_reservations) r WHERE r->>'actualUsd' IS NULL)
  )`, userId);
  if (remaining[0]?.count !== 0) return { pending: true, revoked, purged: 0 };
  // Children can only belong to this owner. Keep the FK protection for any
  // unexpected cross-owner reference rather than deleting somebody else's job.
  await tx.$executeRawUnsafe('UPDATE doc_jobs SET parent_job_id=NULL WHERE user_id=$1', userId);
  const purged = await tx.$executeRawUnsafe('DELETE FROM doc_jobs WHERE user_id=$1', userId);
  return { pending: false, revoked, purged };
}

/** Only resumes a previously authorized account deletion. A soft-delete keeps
 * the existing 30-day grace; hard-delete requests persist their intent in jobs. */
async function reconcileDeletedDocumentAccounts(prisma, hardDeleteUser, graceDays = 30) {
  if (!Number.isFinite(graceDays) || graceDays < 0) throw new Error('DOC_ACCOUNT_RETENTION_INVALID');
  const candidates = await prisma.$queryRawUnsafe(`SELECT u.id FROM users u WHERE u."deletedAt" IS NOT NULL
    AND EXISTS (SELECT 1 FROM doc_jobs j WHERE j.user_id=u.id)
    AND (u."deletedAt"<=clock_timestamp()-$1*interval '1 day' OR EXISTS (
      SELECT 1 FROM doc_jobs j WHERE j.user_id=u.id AND j.account_purge_requested=true))
    AND NOT EXISTS (SELECT 1 FROM doc_jobs j WHERE j.user_id=u.id AND
      (j.deleted_at IS NULL OR j.cleanup_pending=true OR j.quota_settled_at IS NULL))
    ORDER BY u."deletedAt" LIMIT 10`, graceDays);
  for (const candidate of candidates) {
    // hardDeleteUser repeats the actual purge evidence checks under locks.
    try { await hardDeleteUser({ userId: candidate.id, actorId: null }); }
    catch (error) { if (error?.code !== 'P2025') throw error; }
  }
}

module.exports = { prepareDocumentAccountDeletion, reconcileDeletedDocumentAccounts };
