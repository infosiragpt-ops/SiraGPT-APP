'use strict';

/**
 * system-errors/store — ISSUES of «Errores del sistema» on the existing
 * AuditLog table (no schema change):
 *
 *   action 'system_issue'        one row per fingerprint, updated in place
 *     resourceType 'system_issue', resourceId = fingerprint
 *     metadata: title, culprit, kind, level, status (nuevo | en_revision |
 *     resuelto | ignorado), regression, first/last seen, count, hourly
 *     buckets (sparkline + spike), affected users, sanitized samples with
 *     stack, environment / commits, linked request ids and chats.
 *   action 'system_issue_alert'  append-only: one row when an issue is NEW
 *     or a resolved one comes back (REGRESIÓN) — what the admin-wide listener
 *     polls (never one per repeat of a known issue).
 *   action 'system_issue_status' who changed the status, when (audit trail).
 *
 * Every write is best-effort and never throws into the caller.
 */

const ISSUE_ACTION = 'system_issue';
const ALERT_ACTION = 'system_issue_alert';
const STATUS_ACTION = 'system_issue_status';
const RESOURCE_TYPE = 'system_issue';

const STATUSES = Object.freeze(['nuevo', 'en_revision', 'resuelto', 'ignorado']);
const OPEN_STATUSES = Object.freeze(['nuevo', 'en_revision']);
const STATUS_LABELS = Object.freeze({
  nuevo: 'Nuevo',
  en_revision: 'En revisión',
  resuelto: 'Resuelto',
  ignorado: 'Ignorado',
});

const MAX_SAMPLES = 5;
const MAX_USERS = 100;
const MAX_REQ_IDS = 30;
const MAX_CHAT_IDS = 20;
const HOURS_KEPT = 72;
const SPIKE_MIN_EVENTS = 10;
const SPIKE_FACTOR = 5;

function hourKey(ts) {
  return new Date(ts).toISOString().slice(0, 13); // 2026-09-26T19
}

function trimHours(hours, now) {
  const out = {};
  const floor = now - HOURS_KEPT * 3600 * 1000;
  for (const [key, count] of Object.entries(hours || {})) {
    const t = Date.parse(`${key}:00:00.000Z`);
    if (Number.isFinite(t) && t >= floor && Number(count) > 0) out[key] = Number(count);
  }
  return out;
}

function mergeHours(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = (Number(out[k]) || 0) + (Number(v) || 0);
  return out;
}

function unionCapped(a, b, max) {
  const seen = new Set();
  const out = [];
  for (const v of [...(Array.isArray(b) ? b : []), ...(Array.isArray(a) ? a : [])]) {
    if (v == null || v === '') continue;
    const key = String(v);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

/** Events in the last hour vs the hourly average of the 24 before it. */
function spikeOf(hours, now) {
  const lastKey = hourKey(now);
  const prevKey = hourKey(now - 3600 * 1000);
  // «last hour» = the current bucket + the previous one weighted by what is
  // left of the window, approximated as current + previous when early.
  const current = Number(hours[lastKey] || 0) + (new Date(now).getUTCMinutes() < 30 ? Number(hours[prevKey] || 0) : 0);
  let prevTotal = 0;
  for (let h = 2; h <= 25; h += 1) prevTotal += Number(hours[hourKey(now - h * 3600 * 1000)] || 0);
  const avg = prevTotal / 24;
  const spike = current >= SPIKE_MIN_EVENTS && current >= SPIKE_FACTOR * Math.max(1, avg);
  return { spike, lastHour: current, hourlyAvg: Math.round(avg * 10) / 10 };
}

function sparkline(hours, now, buckets = 24) {
  const out = [];
  for (let h = buckets - 1; h >= 0; h -= 1) out.push(Number((hours || {})[hourKey(now - h * 3600 * 1000)] || 0));
  return out;
}

function countSince(hours, now, sinceMs) {
  let n = 0;
  for (const [key, count] of Object.entries(hours || {})) {
    const t = Date.parse(`${key}:00:00.000Z`);
    if (Number.isFinite(t) && t + 3600 * 1000 > now - sinceMs) n += Number(count) || 0;
  }
  return n;
}

function toItem(row, now = Date.now()) {
  const m = (row && row.metadata) || {};
  const hours = m.hours || {};
  const spike = spikeOf(hours, now);
  return {
    id: row.id,
    fingerprint: m.fingerprint || row.resourceId,
    title: m.title || 'Error del sistema',
    culprit: m.culprit || null,
    kind: m.kind || 'backend',
    kindLabel: m.kindLabel || null,
    level: m.level || 'error',
    status: m.status || 'nuevo',
    statusLabel: STATUS_LABELS[m.status] || STATUS_LABELS.nuevo,
    regression: Boolean(m.regression),
    regressedAt: m.regressedAt || null,
    resolvedAt: m.resolvedAt || null,
    resolvedBy: m.resolvedBy || null,
    firstSeen: m.firstSeen || row.createdAt,
    lastSeen: m.lastSeen || row.createdAt,
    count: Number(m.count) || 0,
    lines: Number(m.lines) || Number(m.count) || 0,
    usersCount: Array.isArray(m.users) ? m.users.length : 0,
    events24h: countSince(hours, now, 24 * 3600 * 1000),
    sparkline: sparkline(hours, now, 24),
    spike: spike.spike,
    lastHour: spike.lastHour,
    hourlyAvg: spike.hourlyAvg,
    environment: m.environment || null,
    lastCommit: Array.isArray(m.commits) && m.commits.length ? m.commits[0] : null,
  };
}

function createSystemIssueStore({ prisma = null, now = () => Date.now(), logger = null } = {}) {
  const idCache = new Map(); // fingerprint → row id

  function db() {
    if (prisma) return prisma;
    // eslint-disable-next-line global-require
    return require('../../../config/database');
  }

  function warn(msg, err) {
    try {
      const line = `[system-errors] ${msg}: ${err && err.message ? err.message : err}`;
      if (logger && typeof logger.warn === 'function') logger.warn(line);
    } catch (_) { /* never */ }
  }

  async function findIssueRow(client, fingerprint) {
    const cached = idCache.get(fingerprint);
    if (cached) {
      const row = await client.auditLog.findUnique({ where: { id: cached } }).catch(() => null);
      if (row) return row;
      idCache.delete(fingerprint);
    }
    const row = await client.auditLog.findFirst({
      where: { action: ISSUE_ACTION, resourceType: RESOURCE_TYPE, resourceId: fingerprint },
      orderBy: { createdAt: 'desc' },
    });
    if (row) idCache.set(fingerprint, row.id);
    return row;
  }

  async function writeAlert(client, { fingerprint, issueId, meta, type }) {
    await client.auditLog.create({
      data: {
        actorType: 'system',
        actorId: null,
        actorName: 'Errores del sistema',
        resourceType: RESOURCE_TYPE,
        resourceId: fingerprint,
        action: ALERT_ACTION,
        metadata: {
          issueId,
          fingerprint,
          type, // nuevo | regresion
          title: meta.title,
          culprit: meta.culprit || null,
          kind: meta.kind,
          kindLabel: meta.kindLabel || null,
          level: meta.level,
          tags: ['system-issue', type],
        },
      },
    });
  }

  /**
   * Persist a batch of aggregated events for ONE fingerprint.
   * @param {object} agg { fingerprint, title, culprit, kind, kindLabel, level, count, lines,
   *   hours, users[], reqIds[], chatIds[], samples[], environment, commit, firstAt, lastAt }
   * @returns {Promise<{ id?: string, created?: boolean, regression?: boolean }>}
   */
  async function recordIssue(agg) {
    try {
      const client = db();
      if (!client || !client.auditLog) return {};
      const at = Number(agg.lastAt) || now();
      const nowMs = now();
      const existing = await findIssueRow(client, agg.fingerprint);
      if (!existing) {
        const metadata = {
          fingerprint: agg.fingerprint,
          title: agg.title,
          culprit: agg.culprit || null,
          kind: agg.kind,
          kindLabel: agg.kindLabel || null,
          level: agg.level,
          status: 'nuevo',
          regression: false,
          firstSeen: new Date(Number(agg.firstAt) || at).toISOString(),
          lastSeen: new Date(at).toISOString(),
          count: Number(agg.count) || 1,
          lines: Number(agg.lines) || Number(agg.count) || 1,
          hours: trimHours(agg.hours || { [hourKey(at)]: Number(agg.count) || 1 }, nowMs),
          users: unionCapped([], agg.users, MAX_USERS),
          reqIds: unionCapped([], agg.reqIds, MAX_REQ_IDS),
          chatIds: unionCapped([], agg.chatIds, MAX_CHAT_IDS),
          samples: (agg.samples || []).slice(0, MAX_SAMPLES),
          environment: agg.environment || null,
          commits: agg.commit ? [agg.commit] : [],
          tags: ['system-issue', agg.kind, agg.level].filter(Boolean),
        };
        const row = await client.auditLog.create({
          data: {
            actorType: 'system',
            actorId: null,
            actorName: 'Errores del sistema',
            resourceType: RESOURCE_TYPE,
            resourceId: agg.fingerprint,
            action: ISSUE_ACTION,
            metadata,
          },
        });
        idCache.set(agg.fingerprint, row.id);
        await writeAlert(client, { fingerprint: agg.fingerprint, issueId: row.id, meta: metadata, type: 'nuevo' }).catch((e) => warn('alert write failed', e));
        return { id: row.id, created: true, regression: false };
      }

      const prev = existing.metadata || {};
      const status = STATUSES.includes(prev.status) ? prev.status : 'nuevo';
      // A resolved issue that happens again is a regression: reopen it.
      const regressed = status === 'resuelto';
      const hours = trimHours(mergeHours(prev.hours, agg.hours), nowMs);
      const metadata = {
        ...prev,
        title: prev.title || agg.title,
        culprit: prev.culprit || agg.culprit || null,
        level: prev.level === 'fatal' || agg.level === 'fatal' ? 'fatal' : (prev.level === 'error' || agg.level === 'error' ? 'error' : 'warning'),
        status: regressed ? 'nuevo' : status,
        regression: regressed ? true : Boolean(prev.regression),
        regressedAt: regressed ? new Date(at).toISOString() : (prev.regressedAt || null),
        lastSeen: new Date(at).toISOString(),
        count: (Number(prev.count) || 0) + (Number(agg.count) || 1),
        lines: (Number(prev.lines) || Number(prev.count) || 0) + (Number(agg.lines) || Number(agg.count) || 1),
        hours,
        users: unionCapped(prev.users, agg.users, MAX_USERS),
        reqIds: unionCapped(prev.reqIds, agg.reqIds, MAX_REQ_IDS),
        chatIds: unionCapped(prev.chatIds, agg.chatIds, MAX_CHAT_IDS),
        samples: [...(agg.samples || []), ...(Array.isArray(prev.samples) ? prev.samples : [])].slice(0, MAX_SAMPLES),
        environment: agg.environment || prev.environment || null,
        commits: unionCapped(prev.commits, agg.commit ? [agg.commit] : [], 10),
      };
      const spike = spikeOf(hours, nowMs);
      if (spike.spike) metadata.spikeAt = new Date(nowMs).toISOString();
      await client.auditLog.update({ where: { id: existing.id }, data: { metadata } });
      if (regressed) {
        await writeAlert(client, { fingerprint: agg.fingerprint, issueId: existing.id, meta: metadata, type: 'regresion' }).catch((e) => warn('alert write failed', e));
      }
      return { id: existing.id, created: false, regression: regressed };
    } catch (err) {
      warn('record failed', err);
      return {};
    }
  }

  function buildWhere({ status, kind, q, from, to } = {}) {
    const and = [{ action: ISSUE_ACTION }];
    const statusKey = String(status || 'abiertos');
    if (statusKey === 'abiertos') {
      and.push({ OR: OPEN_STATUSES.map((s) => ({ metadata: { path: ['status'], equals: s } })) });
    } else if (STATUSES.includes(statusKey)) {
      and.push({ metadata: { path: ['status'], equals: statusKey } });
    } else if (statusKey === 'regresiones') {
      and.push({ metadata: { path: ['regression'], equals: true } });
      and.push({ OR: OPEN_STATUSES.map((s) => ({ metadata: { path: ['status'], equals: s } })) });
    }
    if (kind) and.push({ metadata: { path: ['kind'], equals: String(kind) } });
    if (q && String(q).trim()) {
      const needle = String(q).trim().slice(0, 80);
      and.push({
        OR: [
          { metadata: { path: ['title'], string_contains: needle, mode: 'insensitive' } },
          { metadata: { path: ['culprit'], string_contains: needle, mode: 'insensitive' } },
          { resourceId: needle },
        ],
      });
    }
    // The date range filters on lastSeen — applied in memory (list()), JSON
    // range comparisons are not portable across Prisma providers.
    return { AND: and };
  }

  function inRange(item, { from, to } = {}) {
    const last = Date.parse(item.lastSeen);
    if (from && Number.isFinite(Date.parse(from)) && !(last >= Date.parse(from))) return false;
    if (to && Number.isFinite(Date.parse(to)) && !(last <= Date.parse(to))) return false;
    return true;
  }

  async function list(params = {}) {
    const client = db();
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 25));
    const where = buildWhere(params);
    // Sort in memory by lastSeen (JSON path ordering is not portable):
    // bounded to the 1000 most recently created issues.
    const rows = await client.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 1000 });
    const t = now();
    const items = rows
      .map((r) => toItem(r, t))
      .filter((it) => inRange(it, params))
      .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
    const sort = String(params.sort || 'recientes');
    if (sort === 'frecuentes') items.sort((a, b) => b.events24h - a.events24h || b.count - a.count);
    if (sort === 'usuarios') items.sort((a, b) => b.usersCount - a.usersCount || b.count - a.count);
    return {
      items: items.slice((page - 1) * limit, page * limit),
      total: items.length,
      page,
      limit,
      serverTime: new Date(t).toISOString(),
    };
  }

  async function get(id) {
    const client = db();
    const row = await client.auditLog.findUnique({ where: { id: String(id) } });
    if (!row || row.action !== ISSUE_ACTION) return null;
    const m = row.metadata || {};
    const t = now();
    const item = toItem(row, t);
    let users = [];
    const userIds = (Array.isArray(m.users) ? m.users : []).slice(0, 50);
    if (userIds.length && client.user && typeof client.user.findMany === 'function') {
      users = await client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } }).catch(() => []);
    }
    let linkedTurns = [];
    const reqIds = (Array.isArray(m.reqIds) ? m.reqIds : []).slice(0, 20);
    if (reqIds.length) {
      linkedTurns = await client.auditLog.findMany({
        where: {
          action: 'turn_failed',
          OR: reqIds.map((r) => ({ metadata: { path: ['reqIds'], array_contains: [r] } })),
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }).then((rows) => rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        category: r.metadata && r.metadata.category,
        categoryLabel: r.metadata && r.metadata.categoryLabel,
        cause: r.metadata && r.metadata.cause,
        prompt: r.metadata && r.metadata.prompt,
        userEmail: r.actorName || null,
        openLink: r.metadata && r.metadata.openLink,
      }))).catch(() => []);
    }
    const history = await client.auditLog.findMany({
      where: { action: STATUS_ACTION, resourceType: RESOURCE_TYPE, resourceId: item.fingerprint },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }).then((rows) => rows.map((r) => ({
      at: r.createdAt,
      by: r.actorName || r.actorId || null,
      from: r.metadata && r.metadata.from,
      to: r.metadata && r.metadata.to,
    }))).catch(() => []);
    return {
      ...item,
      samples: Array.isArray(m.samples) ? m.samples : [],
      hours48: sparkline(m.hours || {}, t, 48),
      users,
      reqIds,
      chatIds: Array.isArray(m.chatIds) ? m.chatIds : [],
      commits: Array.isArray(m.commits) ? m.commits : [],
      linkedTurns,
      history,
      spikeAt: m.spikeAt || null,
    };
  }

  async function setStatus(id, status, actor = {}) {
    if (!STATUSES.includes(status)) {
      const err = new Error('Estado no válido');
      err.status = 400;
      throw err;
    }
    const client = db();
    const row = await client.auditLog.findUnique({ where: { id: String(id) } });
    if (!row || row.action !== ISSUE_ACTION) return null;
    const prev = row.metadata || {};
    const at = new Date(now()).toISOString();
    const metadata = {
      ...prev,
      status,
      // Marking it resolved closes the regression; a recurrence reopens it.
      regression: status === 'resuelto' || status === 'ignorado' ? false : Boolean(prev.regression),
      resolvedAt: status === 'resuelto' ? at : (status === 'nuevo' || status === 'en_revision' ? null : prev.resolvedAt || null),
      resolvedBy: status === 'resuelto' ? (actor.email || actor.id || null) : (prev.resolvedBy || null),
      ignoredAt: status === 'ignorado' ? at : null,
      reviewedAt: status === 'en_revision' ? at : (prev.reviewedAt || null),
    };
    await client.auditLog.update({ where: { id: row.id }, data: { metadata } });
    await client.auditLog.create({
      data: {
        actorType: 'user',
        actorId: actor.id || null,
        actorName: actor.email || actor.name || null,
        resourceType: RESOURCE_TYPE,
        resourceId: prev.fingerprint || row.resourceId,
        action: STATUS_ACTION,
        metadata: { issueId: row.id, from: prev.status || 'nuevo', to: status, title: prev.title || null },
      },
    }).catch((e) => warn('status audit failed', e));
    return toItem({ ...row, metadata }, now());
  }

  /** New issues and regressions since `since` (the admin-wide listener). */
  async function recent({ since } = {}) {
    const client = db();
    const t = now();
    const sinceDate = since ? new Date(Math.max(Date.parse(since) - 2000, t - 24 * 3600 * 1000)) : new Date(t - 60 * 1000);
    const rows = await client.auditLog.findMany({
      where: { action: ALERT_ACTION, createdAt: { gt: sinceDate } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return {
      serverTime: new Date(t).toISOString(),
      count: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        issueId: (r.metadata && r.metadata.issueId) || null,
        createdAt: r.createdAt,
        type: (r.metadata && r.metadata.type) || 'nuevo',
        title: (r.metadata && r.metadata.title) || 'Error del sistema',
        culprit: (r.metadata && r.metadata.culprit) || null,
        kind: (r.metadata && r.metadata.kind) || 'backend',
        kindLabel: (r.metadata && r.metadata.kindLabel) || null,
        level: (r.metadata && r.metadata.level) || 'error',
      })),
    };
  }

  async function stats() {
    const client = db();
    const t = now();
    const rows = await client.auditLog.findMany({
      where: { action: ISSUE_ACTION },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });
    const items = rows.map((r) => toItem(r, t));
    const day = 24 * 3600 * 1000;
    const open = items.filter((i) => OPEN_STATUSES.includes(i.status));
    const byKind = {};
    for (const i of open) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
    return {
      serverTime: new Date(t).toISOString(),
      open: open.length,
      new24h: items.filter((i) => Date.parse(i.firstSeen) > t - day).length,
      regressions: open.filter((i) => i.regression).length,
      events24h: items.reduce((n, i) => n + i.events24h, 0),
      spikes: open.filter((i) => i.spike).length,
      resolved7d: items.filter((i) => i.status === 'resuelto' && i.resolvedAt && Date.parse(i.resolvedAt) > t - 7 * day).length,
      byKind: Object.entries(byKind).map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    };
  }

  /** Retention: issues silent for `retentionDays`, alerts after 7 days. */
  async function sweepExpired({ retentionDays = 30 } = {}) {
    const client = db();
    const t = now();
    const cutoff = new Date(t - Math.max(1, Number(retentionDays) || 30) * 24 * 3600 * 1000);
    let deletedIssues = 0;
    try {
      // An issue created after the cutoff cannot be silent that long; the
      // lastSeen check itself runs in memory (no JSON range query).
      const candidates = await client.auditLog.findMany({
        where: { action: ISSUE_ACTION, createdAt: { lt: cutoff } },
        select: { id: true, resourceId: true, metadata: true },
        take: 5000,
      });
      const stale = candidates.filter((r) => {
        const last = Date.parse(r.metadata && r.metadata.lastSeen);
        return !Number.isFinite(last) || last < cutoff.getTime();
      });
      if (stale.length) {
        const res = await client.auditLog.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
        deletedIssues = Number(res && res.count) || 0;
        for (const r of stale) idCache.delete(r.resourceId);
      }
    } catch (err) {
      warn('sweep issues failed', err);
    }
    const alerts = await client.auditLog.deleteMany({
      where: { action: ALERT_ACTION, createdAt: { lt: new Date(t - 7 * 24 * 3600 * 1000) } },
    }).catch(() => ({ count: 0 }));
    return { deletedIssues, deletedAlerts: Number(alerts && alerts.count) || 0 };
  }

  return { recordIssue, list, get, setStatus, recent, stats, sweepExpired, toItem, _idCache: idCache };
}

module.exports = {
  ISSUE_ACTION,
  ALERT_ACTION,
  STATUS_ACTION,
  RESOURCE_TYPE,
  STATUSES,
  OPEN_STATUSES,
  STATUS_LABELS,
  createSystemIssueStore,
  hourKey,
  spikeOf,
  sparkline,
  toItem,
};
