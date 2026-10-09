'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { stableStringify } = require('../../middleware/idempotency');
const { quoteMediaCost, finitePrice } = require('./pricing');

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'unknown']);
function mediaError(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
function json(value) { return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item); }
function payloadHash(payload) { return createHash('sha256').update(stableStringify(payload)).digest('hex'); }
function requestKey(req) {
  const value = req.get?.('Idempotency-Key') || req.body?.idempotencyKey || req.body?.streamId;
  if (value != null && (typeof value !== 'string' || !value.trim() || value.length > 256)) {
    throw mediaError('E_PARAMS', 'La clave de solicitud no es válida.', 400);
  }
  return value?.trim() || randomUUID();
}
function normalize(row) {
  if (!row) return null;
  return { ...row, quota_reserved_units: BigInt(row.quota_reserved_units || 0), quota_epoch: BigInt(row.quota_epoch || 0) };
}

function createMediaJobStore(client) {
  async function event(tx, id, type, payload) {
    await tx.$executeRaw(Prisma.sql`INSERT INTO media_job_events(job_id,seq,type,payload)
      SELECT ${id}, COALESCE(MAX(seq),0)+1, ${type}, ${json(payload)}::jsonb FROM media_job_events WHERE job_id=${id}`);
  }
  async function owned(id, userId) {
    const rows = await client.$queryRaw(Prisma.sql`SELECT * FROM media_jobs WHERE id=${id} AND user_id=${userId}`);
    return normalize(rows[0]);
  }
  async function admit({ id = randomUUID(), userId, chatId = null, lane, kind, key, payload, fingerprint = payload, publicInput = {}, quotaUnits = 0, pricing = null }) {
    if (!['image', 'video', 'voice'].includes(lane) || !userId || !kind || !key) throw mediaError('E_PARAMS', 'Solicitud de generación incompleta.', 400);
    const units = BigInt(quotaUnits);
    if (units < 0n) throw mediaError('E_PARAMS', 'La reserva de cuota no es válida.', 400);
    const hash = payloadHash(fingerprint);
    const quote = quoteMediaCost(pricing, payload);
    return client.$transaction(async tx => {
      const owners = await tx.$queryRaw(Prisma.sql`SELECT id,plan,"isSuperAdmin","deletedAt","apiUsage","monthlyLimit","docQuotaEpoch" FROM users WHERE id=${userId} FOR UPDATE`);
      const user = owners[0];
      if (!user || user.deletedAt) throw mediaError('E_FORBIDDEN', 'No se puede iniciar este trabajo.', 403);
      await tx.$queryRaw(Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${json([userId, key])},0))`);
      const prior = await tx.$queryRaw(Prisma.sql`SELECT * FROM media_jobs WHERE user_id=${userId} AND idempotency_key=${key} FOR UPDATE`);
      if (prior[0]) {
        if (prior[0].payload_hash !== hash || prior[0].kind !== kind) throw mediaError('IDEMPOTENCY_CONFLICT', 'La clave ya corresponde a otra solicitud.');
        return { job: normalize(prior[0]), created: false };
      }
      // A fresh key represents a fresh user turn, even for identical content.
      // Only replay the explicit key; content/time-window dedupe loses intent.
      if (lane !== 'voice' && !user.isSuperAdmin && !['PRO', 'PRO_MAX', 'ENTERPRISE'].includes(user.plan)) {
        throw mediaError('UPGRADE_REQUIRED', 'Esta función está disponible en los planes de pago. Sube de plan en /planes para usarla.', 402);
      }
      if (chatId) {
        const chats = await tx.$queryRaw(Prisma.sql`SELECT id FROM chats WHERE id=${chatId} AND "userId"=${userId} AND "deletedAt" IS NULL`);
        if (!chats[0]) throw mediaError('E_FORBIDDEN', 'No se encontró la conversación.', 404);
      }
      if (lane === 'voice') {
        const active = await tx.$queryRaw(Prisma.sql`SELECT id FROM media_jobs WHERE user_id=${userId} AND lane='voice' AND status IN ('queued','running') LIMIT 1`);
        if (active[0]) throw mediaError('job_limit', 'Ya tienes un trabajo de Sira Voz en curso.', 429);
      }
      const reserved = user.isSuperAdmin ? 0n : units;
      const used = BigInt(user.apiUsage || 0), limit = BigInt(user.monthlyLimit || 0);
      if (!user.isSuperAdmin && limit > 0n && used + reserved > limit) throw mediaError('E_QUOTA', 'No queda cuota suficiente para esta generación.', 429);
      if (reserved) await tx.$executeRaw(Prisma.sql`UPDATE users SET "apiUsage"="apiUsage"+${reserved} WHERE id=${userId}`);
      const rows = await tx.$queryRaw(Prisma.sql`INSERT INTO media_jobs(id,user_id,chat_id,lane,kind,idempotency_key,payload_hash,payload,public_input,quota_reserved_units,quota_epoch,pricing_snapshot,estimated_cost_usd,cost_source)
        VALUES(${id},${userId},${chatId},${lane},${kind},${key},${hash},${json(payload)}::jsonb,${json(publicInput)}::jsonb,${reserved},${BigInt(user.docQuotaEpoch || 0)},${quote.snapshot ? json(quote.snapshot) : null}::jsonb,${quote.estimatedCostUSD},${quote.source}) RETURNING *`);
      await event(tx, id, 'job.queued', { job_id: id, lane, phase: 'Encolado' });
      return { job: normalize(rows[0]), created: true };
    });
  }
  async function list(userId, lane, { limit = 20, offset = 0 } = {}) {
    return client.$queryRaw(Prisma.sql`SELECT * FROM media_jobs WHERE user_id=${userId} AND lane=${lane} ORDER BY created_at DESC,id DESC LIMIT ${Math.max(1, Math.min(100, limit))} OFFSET ${Math.max(0, Math.min(100000, offset))}`);
  }
  async function count(userId, lane, activeOnly = false) {
    const rows = await client.$queryRaw(Prisma.sql`SELECT COUNT(*)::int AS count FROM media_jobs WHERE user_id=${userId} AND lane=${lane} ${activeOnly ? Prisma.sql`AND status IN ('queued','running')` : Prisma.empty}`);
    return Number(rows[0]?.count || 0);
  }
  async function claim(kinds, leaseMs = 30000) {
    if (!kinds.length) return null;
    return client.$transaction(async tx => {
      // The same advisory lock serializes CPU-lane claims across replicas.
      await tx.$queryRaw(Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('media-worker-admission',0))`);
      const rows = await tx.$queryRaw(Prisma.sql`SELECT * FROM media_jobs j WHERE kind IN (${Prisma.join(kinds)})
        AND (status='queued' OR (status='running' AND lease_until<timezone('UTC',clock_timestamp())))
        AND (lane<>'voice' OR NOT EXISTS(SELECT 1 FROM media_jobs v WHERE v.lane='voice' AND v.status='running' AND v.lease_until>timezone('UTC',clock_timestamp())))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      if (!rows[0]) return null;
      const token = randomUUID();
      const claimed = await tx.$queryRaw(Prisma.sql`UPDATE media_jobs SET status='running',phase='Preparando',attempt=attempt+1,lease_token=${token},lease_until=timezone('UTC',clock_timestamp())+${leaseMs}*interval '1 millisecond',updated_at=timezone('UTC',clock_timestamp()) WHERE id=${rows[0].id} RETURNING *,EXTRACT(EPOCH FROM (timezone('UTC',clock_timestamp())-created_at))*1000 AS age_ms`);
      await event(tx, rows[0].id, 'job.preparing', { job_id: rows[0].id, phase: 'Preparando' });
      return { ...normalize(claimed[0]), claimed_at_ms: Date.now() };
    });
  }
  async function heartbeat(job, leaseMs = 30000) {
    const rows = await client.$queryRaw(Prisma.sql`UPDATE media_jobs SET lease_until=timezone('UTC',clock_timestamp())+${leaseMs}*interval '1 millisecond' WHERE id=${job.id} AND lease_token=${job.lease_token} AND status='running' AND lease_until>timezone('UTC',clock_timestamp()) RETURNING cancel_requested_at`);
    if (!rows[0]) throw mediaError('LEASE_LOST', 'El trabajo continúa en otro proceso.');
    return { cancelRequested: Boolean(rows[0].cancel_requested_at) };
  }
  async function checkpoint(job, patch, { phase, progress } = {}) {
    const rows = await client.$queryRaw(Prisma.sql`UPDATE media_jobs SET checkpoint=checkpoint||${json(patch)}::jsonb,
      phase=COALESCE(${phase || null},phase),progress=COALESCE(${Number.isFinite(progress) ? Math.max(0, Math.min(99, Math.round(progress))) : null},progress),updated_at=timezone('UTC',clock_timestamp())
      WHERE id=${job.id} AND lease_token=${job.lease_token} AND status='running' AND lease_until>timezone('UTC',clock_timestamp()) AND cancel_requested_at IS NULL RETURNING *`);
    if (!rows[0]) {
      const stopped = await client.$queryRaw(Prisma.sql`SELECT cancel_requested_at FROM media_jobs WHERE id=${job.id} AND lease_token=${job.lease_token} AND status='running' AND lease_until>timezone('UTC',clock_timestamp())`);
      if (stopped[0]?.cancel_requested_at) throw mediaError('E_CANCELLED', 'Cancelado por el usuario.');
      throw mediaError('LEASE_LOST', 'El trabajo continúa en otro proceso.');
    }
    job.checkpoint = rows[0].checkpoint;
    return normalize(rows[0]);
  }
  async function defer(job, delayMs = 1500) {
    // Keep the durable provider checkpoint, but release ownership. A fresh
    // worker may retrieve the same result; it may never submit it again.
    const changed = await client.$executeRaw(Prisma.sql`UPDATE media_jobs SET lease_token=NULL,lease_until=timezone('UTC',clock_timestamp())+${delayMs}*interval '1 millisecond',updated_at=timezone('UTC',clock_timestamp()) WHERE id=${job.id} AND lease_token=${job.lease_token} AND status='running' AND lease_until>timezone('UTC',clock_timestamp())`);
    if (!changed) throw mediaError('LEASE_LOST', 'El trabajo continúa en otro proceso.');
  }
  async function settle(job, { status, result = null, code = null, message = null, actualCostUSD = null, providerCalled = false, onCompleted, quotaUsedUnits } = {}) {
    if (!TERMINAL.has(status)) throw new Error('Invalid media terminal status');
    return client.$transaction(async tx => {
      // Lock order matches admission/account deletion/reset: user, then job.
      const owners = await tx.$queryRaw(Prisma.sql`SELECT "docQuotaEpoch" FROM users WHERE id=${job.user_id} FOR UPDATE`);
      const rows = await tx.$queryRaw(Prisma.sql`SELECT *,lease_until>timezone('UTC',clock_timestamp()) AS lease_valid FROM media_jobs WHERE id=${job.id} FOR UPDATE`);
      const current = rows[0];
      if (!current || current.lease_token !== job.lease_token || current.status !== 'running' || !current.lease_valid) throw mediaError('LEASE_LOST', 'El trabajo continúa en otro proceso.');
      if (current.cancel_requested_at) { status = 'cancelled'; result = null; code = 'E_CANCELLED'; message = 'Cancelado por el usuario.'; }
      const actual = finitePrice(actualCostUSD);
      // Commercial quota units are not provider tokens. Keep existing units,
      // reserve before work, and refund failed/no-result outcomes exactly once.
      const reserved = BigInt(current.quota_reserved_units);
      const requestedUse = quotaUsedUnits == null ? reserved : BigInt(quotaUsedUnits);
      const used = status === 'completed' ? (requestedUse < 0n ? 0n : requestedUse > reserved ? reserved : requestedUse) : 0n;
      if (!current.quota_settled_at && owners[0] && BigInt(owners[0].docQuotaEpoch) === BigInt(current.quota_epoch)) {
        await tx.$executeRaw(Prisma.sql`UPDATE users SET "apiUsage"=GREATEST(0,"apiUsage"-${BigInt(current.quota_reserved_units)}+${used}) WHERE id=${job.user_id}`);
      }
      if (!current.quota_settled_at && (providerCalled || status === 'completed')) {
        await tx.$executeRaw(Prisma.sql`INSERT INTO api_usage(id,"userId",model,tokens,cost,timestamp)
          VALUES(${`media-usage-${job.id}`},${job.user_id},${String(current.payload.model || 'Sira Voz')},0,${actual},timezone('UTC',clock_timestamp())) ON CONFLICT(id) DO NOTHING`);
      }
      // The job lock fences cancellation and stale leases through the chat
      // write and terminal settlement. No cancelled job can publish a result.
      if (status === 'completed' && onCompleted) await onCompleted(tx, result);
      const updated = await tx.$queryRaw(Prisma.sql`UPDATE media_jobs SET status=${status},phase=${status === 'completed' ? 'Listo' : status === 'cancelled' ? 'Cancelado' : 'Fallido'},progress=${status === 'completed' ? 100 : current.progress},result=${result ? json(result) : null}::jsonb,error_code=${code},error_message=${message},actual_cost_usd=${actual},cost_source=${actual != null ? 'provider_reported' : current.cost_source},quota_used_units=${used},quota_settled_at=timezone('UTC',clock_timestamp()),finished_at=timezone('UTC',clock_timestamp()),updated_at=timezone('UTC',clock_timestamp()),lease_token=NULL,lease_until=NULL WHERE id=${job.id} RETURNING *`);
      await event(tx, job.id, status === 'completed' ? 'job.ready' : status === 'cancelled' ? 'job.cancelled' : 'job.failed', { job_id: job.id, code, phase: updated[0].phase });
      return normalize(updated[0]);
    });
  }
  async function cancel(userId, id) {
    return client.$transaction(async tx => {
      const rows = await tx.$queryRaw(Prisma.sql`SELECT * FROM media_jobs WHERE id=${id} AND user_id=${userId} FOR UPDATE`);
      if (!rows[0]) return null;
      if (TERMINAL.has(rows[0].status)) return normalize(rows[0]);
      const changed = await tx.$queryRaw(Prisma.sql`UPDATE media_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,timezone('UTC',clock_timestamp())),updated_at=timezone('UTC',clock_timestamp()) WHERE id=${id} RETURNING *`);
      return normalize(changed[0]);
    });
  }
  return { admit, owned, list, count, claim, heartbeat, checkpoint, defer, settle, cancel };
}
let singleton;
function getMediaJobStore() { return singleton ||= createMediaJobStore(require('../../config/database')); }
module.exports = { createMediaJobStore, getMediaJobStore, mediaError, requestKey, payloadHash, TERMINAL };
