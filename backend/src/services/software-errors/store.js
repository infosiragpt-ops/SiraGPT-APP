'use strict';

/**
 * software-errors/store — persistent error stream + audit trail.
 *
 * Uses a dedicated `software_error` table (created on first use via raw SQL
 * so we do not depend on prisma migrate; SKIP_MIGRATIONS=1 in prod) and
 * writes the repair lifecycle to AuditLog:
 *   error_detected → repair_started → repair_succeeded | repair_failed
 * actor is always `system` for autonomous work.
 */

const crypto = require('crypto');
const prisma = require('../../config/database');
const { writeAuditLog } = require('../../utils/audit-log');

const OPEN_STATUSES = Object.freeze(['detected', 'repairing', 'needs_attention']);
const STATUSES = Object.freeze(['detected', 'repairing', 'repaired', 'needs_attention']);
const SEVERITIES = Object.freeze(['critical', 'error', 'warning']);

let tableReady = null;

function newId() {
  return `swe_${crypto.randomBytes(12).toString('hex')}`;
}

function fingerprintOf(parts) {
  const raw = (Array.isArray(parts) ? parts : [parts])
    .map((p) => String(p || '').trim().toLowerCase())
    .join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function safeText(value, max = 2000) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, max);
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

async function ensureTable() {
  if (tableReady) return tableReady;
  tableReady = (async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS software_error (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        source TEXT NOT NULL,
        service TEXT NOT NULL,
        severity TEXT NOT NULL,
        class TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        status TEXT NOT NULL DEFAULT 'detected',
        repair_class TEXT,
        repair_attempts INTEGER NOT NULL DEFAULT 0,
        last_repair_at TIMESTAMPTZ,
        metadata JSONB,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        occurrence_count INTEGER NOT NULL DEFAULT 1
      )
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS software_error_status_seen
        ON software_error (status, last_seen_at DESC)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS software_error_fp
        ON software_error (fingerprint)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS software_error_service
        ON software_error (service, last_seen_at DESC)
    `);
  })().catch((err) => {
    tableReady = null;
    throw err;
  });
  return tableReady;
}

async function writeLifecycleAudit(action, row, detailEs, extra = {}) {
  const metadata = {
    errorId: row.id,
    fingerprint: row.fingerprint,
    source: row.source,
    service: row.service,
    severity: row.severity,
    class: row.class,
    status: row.status,
    repairClass: row.repair_class || row.repairClass || null,
    detail: safeText(detailEs, 400),
    ...safeJson(extra),
  };
  await writeAuditLog(prisma, {
    actorType: 'system',
    actorId: 'system',
    actorName: 'system',
    resourceType: 'software_error',
    resourceId: row.id,
    action,
    metadata,
    tags: ['software-error', 'autonome', action],
  });
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    source: row.source,
    service: row.service,
    severity: row.severity,
    class: row.class,
    title: row.title,
    detail: row.detail,
    status: row.status,
    repairClass: row.repair_class,
    repairAttempts: Number(row.repair_attempts || 0),
    lastRepairAt: row.last_repair_at,
    metadata: row.metadata || {},
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    occurrenceCount: Number(row.occurrence_count || 1),
    createdAt: row.last_seen_at || row.first_seen_at,
  };
}

async function upsertError(input) {
  await ensureTable();
  const fingerprint = input.fingerprint || fingerprintOf([
    input.class, input.service, input.title, input.resourceId,
  ]);
  const title = safeText(input.title, 240) || 'Error de software';
  const detail = safeText(input.detail, 2000);
  const source = safeText(input.source, 64) || 'unknown';
  const service = safeText(input.service, 64) || 'backend';
  const severity = SEVERITIES.includes(input.severity) ? input.severity : 'error';
  const klass = safeText(input.class, 64) || 'unknown';
  const repairClass = safeText(input.repairClass, 64);
  const metadata = safeJson(input.metadata);

  const existing = await prisma.$queryRawUnsafe(
    `SELECT * FROM software_error
     WHERE fingerprint = $1 AND status = ANY($2::text[])
     ORDER BY last_seen_at DESC LIMIT 1`,
    fingerprint,
    OPEN_STATUSES,
  );
  const current = Array.isArray(existing) ? existing[0] : null;
  if (current) {
    await prisma.$executeRawUnsafe(
      `UPDATE software_error
       SET last_seen_at = NOW(),
           occurrence_count = occurrence_count + 1,
           detail = COALESCE($2, detail),
           metadata = COALESCE($3::jsonb, metadata),
           severity = $4
       WHERE id = $1`,
      current.id,
      detail,
      JSON.stringify(metadata),
      severity,
    );
    const refreshed = await getError(current.id);
    return { row: refreshed, created: false };
  }

  const id = newId();
  await prisma.$executeRawUnsafe(
    `INSERT INTO software_error (
       id, fingerprint, source, service, severity, class, title, detail,
       status, repair_class, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'detected',$9,$10::jsonb)`,
    id, fingerprint, source, service, severity, klass, title, detail,
    repairClass, JSON.stringify(metadata),
  );
  const row = await getError(id);
  await writeLifecycleAudit('error_detected', row, detail || title);
  return { row, created: true };
}

async function getError(id) {
  await ensureTable();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM software_error WHERE id = $1 LIMIT 1`,
    String(id || ''),
  );
  return mapRow(Array.isArray(rows) ? rows[0] : null);
}

async function setStatus(id, status, extra = {}) {
  await ensureTable();
  if (!STATUSES.includes(status)) throw new Error('invalid_status');
  const resolved = status === 'repaired' ? 'NOW()' : 'NULL';
  await prisma.$executeRawUnsafe(
    `UPDATE software_error
     SET status = $2,
         resolved_at = ${status === 'repaired' ? 'NOW()' : 'resolved_at'},
         last_repair_at = CASE WHEN $3 THEN NOW() ELSE last_repair_at END,
         repair_attempts = repair_attempts + CASE WHEN $4 THEN 1 ELSE 0 END,
         detail = COALESCE($5, detail)
     WHERE id = $1`,
    String(id),
    status,
    Boolean(extra.touchRepair),
    Boolean(extra.incAttempts),
    extra.detail ? safeText(extra.detail, 2000) : null,
  );
  return getError(id);
}

async function listErrors(query = {}) {
  await ensureTable();
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
  const offset = (page - 1) * limit;
  const where = [];
  const params = [];
  let i = 1;
  if (query.severity && SEVERITIES.includes(query.severity)) {
    where.push(`severity = $${i++}`);
    params.push(query.severity);
  }
  if (query.service) {
    where.push(`service = $${i++}`);
    params.push(String(query.service));
  }
  if (query.status && query.status !== 'all') {
    where.push(`status = $${i++}`);
    params.push(String(query.status));
  }
  if (query.from) {
    where.push(`last_seen_at >= $${i++}::timestamptz`);
    params.push(String(query.from));
  }
  if (query.to) {
    where.push(`last_seen_at <= $${i++}::timestamptz`);
    params.push(String(query.to));
  }
  if (query.q && String(query.q).trim()) {
    where.push(`(title ILIKE $${i} OR detail ILIKE $${i} OR service ILIKE $${i} OR class ILIKE $${i})`);
    params.push(`%${String(query.q).trim().slice(0, 80)}%`);
    i += 1;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM software_error ${clause}`,
    ...params,
  );
  const total = Number(countRows?.[0]?.n || 0);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM software_error ${clause}
     ORDER BY last_seen_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    ...params,
  );
  return {
    items: (rows || []).map(mapRow),
    page,
    limit,
    total,
    hasMore: offset + (rows || []).length < total,
  };
}

async function listOpenByClass(klass) {
  await ensureTable();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM software_error
     WHERE class = $1 AND status = ANY($2::text[])
     ORDER BY last_seen_at DESC`,
    String(klass),
    OPEN_STATUSES,
  );
  return (rows || []).map(mapRow);
}

async function markRepairedIfGone(id, detailEs) {
  const row = await setStatus(id, 'repaired', { detail: detailEs });
  if (row) {
    await writeLifecycleAudit('repair_succeeded', row, detailEs || 'Error resuelto.');
  }
  return row;
}

const httpBuffer = [];
const MAX_BUFFER = 200;

function recordHttp5xx(req, res, err) {
  try {
    const path = String(req?.originalUrl || req?.url || '').split('?')[0];
    if (!path || /^\/(health|ready|live|api\/health)/.test(path)) return;
    if (path.includes('/health/')) return;
    const status = Number(res?.statusCode || err?.status || err?.statusCode || 500);
    if (status < 500) return;
    httpBuffer.push({
      at: new Date().toISOString(),
      method: String(req?.method || 'GET'),
      path: path.slice(0, 200),
      status,
      message: safeText(err?.message || res?.statusMessage, 400),
      requestId: req?.requestId || req?.headers?.['x-request-id'] || null,
    });
    if (httpBuffer.length > MAX_BUFFER) httpBuffer.splice(0, httpBuffer.length - MAX_BUFFER);
  } catch {
    /* never break the request */
  }
}

function recordUncaught(error, kind = 'uncaughtException') {
  try {
    httpBuffer.push({
      at: new Date().toISOString(),
      method: 'PROCESS',
      path: kind,
      status: 500,
      message: safeText(error?.stack || error?.message || error, 800),
      requestId: null,
      uncaught: true,
      kind,
    });
    if (httpBuffer.length > MAX_BUFFER) httpBuffer.splice(0, httpBuffer.length - MAX_BUFFER);
  } catch {
    /* ignore */
  }
}

function drainHttpBuffer() {
  return httpBuffer.splice(0, httpBuffer.length);
}

function recordWebtopFailure(payload) {
  try {
    const item = {
      class: payload?.error === 'project_not_found' ? 'webtop_project_not_found' : 'webtop_session',
      source: 'webtop',
      service: 'webtop',
      severity: 'error',
      title: payload?.error || 'webtop_failure',
      detail: payload?.message || payload?.detail || null,
      repairClass: 'webtop_session_start',
      resourceId: [payload?.projectId, payload?.departmentId].filter(Boolean).join(':'),
      metadata: {
        projectId: payload?.projectId || null,
        departmentId: payload?.departmentId || null,
        error: payload?.error || null,
        status: payload?.status || null,
      },
    };
    item.fingerprint = fingerprintOf([item.class, item.resourceId, item.title]);
    // Persist immediately so a 404 is visible without waiting for the loop.
    void upsertError(item).catch(() => {});
  } catch {
    /* ignore */
  }
}

module.exports = {
  OPEN_STATUSES,
  STATUSES,
  SEVERITIES,
  ensureTable,
  fingerprintOf,
  upsertError,
  getError,
  setStatus,
  listErrors,
  listOpenByClass,
  markRepairedIfGone,
  writeLifecycleAudit,
  recordHttp5xx,
  recordUncaught,
  drainHttpBuffer,
  recordWebtopFailure,
  safeText,
};
