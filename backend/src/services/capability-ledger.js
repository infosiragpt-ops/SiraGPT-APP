'use strict';

/**
 * capability-ledger — the durable record of what the software acquired (or
 * could not acquire) by itself, written as AuditLog rows so it is visible in
 * Admin → Logs → Auditoría today and queryable by action without a schema
 * change.
 *
 *   agent.capability_gap      the agent hit «I cannot do X» (missing Python
 *                             module / binary / tool) — allowed or not
 *   agent.capability_install  allowlisted packages installed into a sandbox
 *   agent.host_bash           a host_bash execution (install calls flagged)
 *
 * Every writer is fire-and-forget and never throws: a ledger failure must
 * not break the turn that produced it. Under NODE_ENV=test nothing is
 * written unless a prisma client is injected.
 */

const ACTIONS = Object.freeze({
  gap: 'agent.capability_gap',
  install: 'agent.capability_install',
  hostBash: 'agent.host_bash',
});

const MAX_TEXT = 300;

function clip(value, max = MAX_TEXT) {
  const s = value == null ? '' : String(value);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function lazyPrisma(env = process.env) {
  if (String(env.NODE_ENV || '') === 'test') return null;
  try {
    // eslint-disable-next-line global-require
    return require('../config/database');
  } catch (_) {
    return null;
  }
}

async function write(prisma, entry) {
  const client = prisma || lazyPrisma();
  if (!client) return null;
  try {
    // eslint-disable-next-line global-require
    const { writeAuditLog } = require('../utils/audit-log');
    return await writeAuditLog(client, entry);
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} p
 * @param {string} [p.userId]
 * @param {string} [p.chatId]
 * @param {'python_package'|'binary'|'tool'|'skill'|'mcp'} p.kind
 * @param {string} p.name       the import / command the agent needed
 * @param {string} [p.package]  the distribution it maps to (python)
 * @param {boolean} [p.allowed] whether the policy would have allowed it
 * @param {string} [p.tool]     the tool that surfaced the gap
 * @param {string} [p.source]   agent-runner | chat | host_bash
 */
function recordCapabilityGap({ userId = null, chatId = null, kind, name, package: pkg = null, allowed = false, tool = null, source = 'agent-runner', prisma = null } = {}) {
  if (!name) return Promise.resolve(null);
  return write(prisma, {
    action: ACTIONS.gap,
    userId: userId || undefined,
    resource: 'chat',
    resourceId: chatId || undefined,
    metadata: {
      kind: clip(kind, 40) || 'unknown',
      name: clip(name, 120),
      package: pkg ? clip(pkg, 120) : null,
      allowed: Boolean(allowed),
      tool: tool ? clip(tool, 60) : null,
      source: clip(source, 40),
    },
    tags: ['capability', 'gap', String(kind || 'unknown')],
  });
}

/**
 * @param {object} p
 * @param {string[]} p.requested   the specs the agent asked for
 * @param {{name:string,version:string}[]} [p.installed]
 * @param {number} [p.bytes]
 * @param {number} [p.durationMs]
 * @param {string} [p.driver]      docker | local | remote
 * @param {string} [p.code]        ok | not_allowed | not_found | …
 */
function recordCapabilityInstall({ userId = null, chatId = null, requested = [], installed = [], bytes = 0, durationMs = 0, driver = null, code = 'ok', prisma = null } = {}) {
  return write(prisma, {
    action: ACTIONS.install,
    userId: userId || undefined,
    resource: 'chat',
    resourceId: chatId || undefined,
    metadata: {
      kind: 'python_package',
      requested: (Array.isArray(requested) ? requested : []).slice(0, 20).map((s) => clip(s, 100)),
      installed: (Array.isArray(installed) ? installed : []).slice(0, 50).map((i) => ({ name: clip(i && i.name, 100), version: clip(i && i.version, 40) })),
      bytes: Number(bytes) || 0,
      durationMs: Number(durationMs) || 0,
      driver: driver ? clip(driver, 20) : null,
      ok: code === 'ok',
      code: clip(code, 40),
    },
    tags: ['capability', 'install', code === 'ok' ? 'ok' : 'failed'],
  });
}

/**
 * One row per host_bash execution so Admin → Logs shows what ran on the
 * backend host. Install commands are flagged (`install: true`) with their
 * package names; command text is clipped and never includes the env.
 */
function recordHostCommand({ userId = null, chatId = null, command, workingDir = null, exitCode = null, ok = false, timedOut = false, install = false, packages = [], blocked = null, prisma = null } = {}) {
  return write(prisma, {
    action: ACTIONS.hostBash,
    userId: userId || undefined,
    resource: 'chat',
    resourceId: chatId || undefined,
    metadata: {
      command: clip(command, MAX_TEXT),
      workingDir: workingDir ? clip(workingDir, 200) : null,
      exitCode: exitCode == null ? null : Number(exitCode),
      ok: Boolean(ok),
      timedOut: Boolean(timedOut),
      install: Boolean(install),
      packages: (Array.isArray(packages) ? packages : []).slice(0, 20).map((s) => clip(s, 100)),
      blocked: blocked ? clip(blocked, 60) : null,
    },
    tags: ['host_bash', ...(install ? ['capability', 'install'] : []), ...(blocked ? ['blocked'] : [])],
  });
}

/**
 * Admin listing. `action` narrows to one of ACTIONS; by default the three
 * capability actions. Rows are returned newest first with a compact shape.
 */
async function listCapabilityEvents(prisma, { limit = 100, action = null, userId = null, since = null } = {}) {
  if (!prisma || !prisma.auditLog || typeof prisma.auditLog.findMany !== 'function') return [];
  const actions = action && Object.values(ACTIONS).includes(action) ? [action] : Object.values(ACTIONS);
  const where = { action: { in: actions } };
  if (userId) where.actorId = String(userId);
  if (since instanceof Date && !Number.isNaN(since.getTime())) where.createdAt = { gte: since };
  const take = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, action: true, actorId: true, resourceId: true, metadata: true, createdAt: true },
  });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    userId: row.actorId || null,
    chatId: row.resourceId || null,
    createdAt: row.createdAt,
    ...(row.metadata && typeof row.metadata === 'object' ? { metadata: row.metadata } : {}),
  }));
}

/** Aggregate the gaps by package so an operator sees what to allowlist next. */
function summarizeGaps(events) {
  const counts = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (event.action !== ACTIONS.gap || !event.metadata) continue;
    const key = String(event.metadata.package || event.metadata.name || '').toLowerCase();
    if (!key) continue;
    const entry = counts.get(key) || { name: key, kind: event.metadata.kind || 'unknown', allowed: Boolean(event.metadata.allowed), count: 0, lastAt: null };
    entry.count += 1;
    if (!entry.lastAt || event.createdAt > entry.lastAt) entry.lastAt = event.createdAt;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

module.exports = {
  ACTIONS,
  recordCapabilityGap,
  recordCapabilityInstall,
  recordHostCommand,
  listCapabilityEvents,
  summarizeGaps,
};
