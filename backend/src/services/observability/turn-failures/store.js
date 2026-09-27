'use strict';

/**
 * turn-failures/store — persistence + queries for failed user turns.
 *
 * Rows live in the existing AuditLog table (no schema change):
 *   action       = 'turn_failed'
 *   resourceType = 'chat_turn'
 *   resourceId   = '<chatId>:<turnKey>'   (one row per failed turn)
 *   actorId/Name = the user who asked
 *   metadata     = category, cause, prompt excerpt, model, route, timings,
 *                  what the user saw, stage trail, notes, signals…
 *
 * Writes are fire-and-forget from the caller's point of view and NEVER
 * throw. A second signal for the same turn (client report after the server
 * finalizer, sin_cierre then the real end…) merges into the same row. A
 * flood of identical causes is rate-limited per fingerprint.
 */

const {
  CATEGORIES,
  SEVERITY_RANK,
  maxSeverity,
} = require('./classify');

const ACTION = 'turn_failed';
const RESOURCE_TYPE = 'chat_turn';
const MERGE_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
const MAX_SIGNALS = 12;
const MAX_NOTES = 40;
const MAX_STAGES = 15;

const SECRET_RES = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:jwt]'],
  [/\b(?:sk|pk|rk|xai|gsk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}\b/gi, '[REDACTED:key]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED:key]'],
  [/\b(api[_-]?key|password|secret|token)=([^&\s"']+)/gi, '$1=[REDACTED]'],
];

function redact(value, max = 500) {
  if (value == null) return null;
  let text = typeof value === 'string' ? value : String(value);
  for (const [re, rep] of SECRET_RES) text = text.replace(re, rep);
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sanitizeDeep(input, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (input == null) return null;
  if (typeof input === 'string') return redact(input, 1200);
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (Array.isArray(input)) return input.slice(0, 40).map((v) => sanitizeDeep(v, depth + 1));
  if (typeof input !== 'object') return redact(String(input), 300);
  const out = {};
  for (const [key, value] of Object.entries(input).slice(0, 60)) {
    if (/password|secret|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer/i.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = sanitizeDeep(value, depth + 1);
  }
  return out;
}

function rankOf(severity) {
  return SEVERITY_RANK[severity] || 0;
}

/**
 * Merge a new signal for the same turn into the stored metadata. The most
 * severe category stays primary; every signal is kept (bounded) so the
 * admin sees «el servidor lo cerró bien, pero el navegador reportó…».
 */
function mergeMetadata(prev = {}, next = {}) {
  const base = prev && typeof prev === 'object' ? { ...prev } : {};
  const incoming = next && typeof next === 'object' ? next : {};
  const primaryIsNew = rankOf(incoming.severity) > rankOf(base.severity);
  const merged = { ...incoming, ...base };
  if (primaryIsNew) {
    merged.category = incoming.category;
    merged.categoryLabel = incoming.categoryLabel;
    merged.severity = incoming.severity;
    merged.sound = incoming.sound;
    merged.cause = incoming.cause;
    merged.fingerprint = incoming.fingerprint;
    merged.reasons = incoming.reasons;
  } else {
    merged.severity = maxSeverity(base.severity, incoming.severity);
  }
  // Fields where the later observation is more complete.
  for (const key of ['finalSeen', 'whatUserSaw', 'totalMs', 'endReason', 'artifactsCount', 'modelUsed', 'providerUsed', 'fallbackChain', 'errorMessage', 'errorCode', 'status']) {
    if (incoming[key] != null && incoming[key] !== '' && (base[key] == null || base[key] === '' || base[key] === '(nada)')) {
      merged[key] = incoming[key];
    }
  }
  const signals = [
    ...(Array.isArray(base.signals) ? base.signals : []),
    ...(Array.isArray(incoming.signals) ? incoming.signals : []),
  ];
  merged.signals = signals.slice(-MAX_SIGNALS);
  const notes = [
    ...(Array.isArray(base.notes) ? base.notes : []),
    ...(Array.isArray(incoming.notes) ? incoming.notes : []),
  ];
  merged.notes = notes.slice(-MAX_NOTES);
  const reqIds = new Set([
    ...(Array.isArray(base.reqIds) ? base.reqIds : []),
    ...(Array.isArray(incoming.reqIds) ? incoming.reqIds : []),
  ].filter(Boolean));
  merged.reqIds = Array.from(reqIds).slice(0, 10);
  if (Array.isArray(incoming.stages) && incoming.stages.length > (Array.isArray(base.stages) ? base.stages.length : 0)) {
    merged.stages = incoming.stages.slice(-MAX_STAGES);
  }
  merged.occurrences = Number(base.occurrences || 1) + 1;
  merged.lastSignalAt = incoming.lastSignalAt || new Date().toISOString();
  return merged;
}

function createTurnFailureStore({
  prisma: injectedPrisma = null,
  now = () => Date.now(),
  logger = console,
  rateLimitPerMinute = Number(process.env.SIRAGPT_TURN_FAILURE_RATE_LIMIT || DEFAULT_RATE_LIMIT_PER_MINUTE),
} = {}) {
  const resourceIndex = new Map(); // resourceId -> { id, at }
  const floods = new Map(); // fingerprint -> { windowStart, count, suppressed }
  const emailCache = new Map(); // userId -> email
  let totalTurnsCache = { at: 0, since: 0, value: null };

  async function emailFor(userId) {
    if (!userId) return null;
    if (emailCache.has(userId)) return emailCache.get(userId);
    try {
      const client = db();
      if (!client.user || typeof client.user.findUnique !== 'function') return null;
      const row = await client.user.findUnique({ where: { id: String(userId) }, select: { email: true } });
      const email = row && row.email ? String(row.email) : null;
      emailCache.set(userId, email);
      if (emailCache.size > 2000) emailCache.delete(emailCache.keys().next().value);
      return email;
    } catch (_) {
      return null;
    }
  }

  function db() {
    if (injectedPrisma) return injectedPrisma;
    // eslint-disable-next-line global-require
    return require('../../../config/database');
  }

  function rememberResource(resourceId, id) {
    resourceIndex.set(resourceId, { id, at: now() });
    if (resourceIndex.size > 4000) {
      const oldest = resourceIndex.keys().next().value;
      resourceIndex.delete(oldest);
    }
  }

  function floodCheck(fingerprint) {
    if (!fingerprint || !(rateLimitPerMinute > 0)) return { allowed: true, suppressed: 0 };
    const t = now();
    let state = floods.get(fingerprint);
    if (!state || t - state.windowStart >= 60_000) {
      const suppressed = state ? state.suppressed : 0;
      state = { windowStart: t, count: 0, suppressed: 0 };
      floods.set(fingerprint, state);
      if (floods.size > 2000) floods.delete(floods.keys().next().value);
      state.count += 1;
      return { allowed: true, suppressed };
    }
    if (state.count >= rateLimitPerMinute) {
      state.suppressed += 1;
      return { allowed: false, suppressed: state.suppressed };
    }
    state.count += 1;
    return { allowed: true, suppressed: 0 };
  }

  async function findExisting(resourceId) {
    const cached = resourceIndex.get(resourceId);
    if (cached && now() - cached.at < MERGE_WINDOW_MS) return { id: cached.id, fromCache: true };
    const client = db();
    if (!client || !client.auditLog || typeof client.auditLog.findFirst !== 'function') return null;
    const row = await client.auditLog.findFirst({
      where: {
        action: ACTION,
        resourceType: RESOURCE_TYPE,
        resourceId,
        createdAt: { gte: new Date(now() - MERGE_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, metadata: true },
    });
    return row || null;
  }

  /**
   * Persist (or merge) one failed turn. Never throws.
   * @param {{resourceId: string, userId?: string|null, userEmail?: string|null, metadata: object}} entry
   * @returns {Promise<{id?: string, merged?: boolean, suppressed?: boolean}>}
   */
  async function record(entry) {
    try {
      if (!entry || !entry.metadata || !entry.metadata.category || !CATEGORIES[entry.metadata.category]) return {};
      const client = db();
      if (!client || !client.auditLog || typeof client.auditLog.create !== 'function') return {};
      const resourceId = String(entry.resourceId || `sin-chat:${now()}`).slice(0, 190);
      const metadata = sanitizeDeep({
        ...entry.metadata,
        lastSignalAt: new Date(now()).toISOString(),
      });

      const existing = await findExisting(resourceId).catch(() => null);
      if (existing && existing.id) {
        let prevMeta = existing.metadata;
        if (!prevMeta && typeof client.auditLog.findUnique === 'function') {
          const row = await client.auditLog.findUnique({ where: { id: existing.id }, select: { metadata: true } }).catch(() => null);
          prevMeta = row && row.metadata;
        }
        const merged = mergeMetadata(prevMeta || {}, metadata);
        await client.auditLog.update({ where: { id: existing.id }, data: { metadata: merged } });
        rememberResource(resourceId, existing.id);
        return { id: existing.id, merged: true };
      }

      const gate = floodCheck(metadata.fingerprint);
      if (!gate.allowed) return { suppressed: true };
      if (gate.suppressed) metadata.suppressedBefore = gate.suppressed;

      const actorName = entry.userEmail || (await emailFor(entry.userId));
      const row = await client.auditLog.create({
        data: {
          actorType: entry.userId ? 'user' : 'system',
          actorId: entry.userId || null,
          actorName: actorName || null,
          resourceType: RESOURCE_TYPE,
          resourceId,
          action: ACTION,
          before: null,
          after: null,
          diff: null,
          metadata: { ...metadata, occurrences: 1, tags: ['turn-failure', metadata.category, metadata.severity].filter(Boolean) },
        },
        select: { id: true },
      });
      if (row && row.id) rememberResource(resourceId, row.id);
      return { id: row && row.id };
    } catch (err) {
      try { logger.warn?.(`[turn-failures] record failed: ${err && err.message ? err.message : err}`); } catch (_) { /* ignore */ }
      return {};
    }
  }

  function toItem(row) {
    const m = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    return {
      id: row.id,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
      userId: row.actorId || null,
      userEmail: row.actorName || null,
      resourceId: row.resourceId || null,
      category: m.category || null,
      categoryLabel: m.categoryLabel || (CATEGORIES[m.category] && CATEGORIES[m.category].label) || m.category || null,
      severity: m.severity || null,
      sound: m.sound || (CATEGORIES[m.category] && CATEGORIES[m.category].sound) || 'strong',
      cause: m.cause || null,
      fingerprint: m.fingerprint || null,
      model: m.modelLabel || m.modelUsed || m.modelPicked || null,
      route: m.route || null,
      prompt: m.prompt || null,
      whatUserSaw: m.whatUserSaw || null,
      totalMs: typeof m.totalMs === 'number' ? m.totalMs : null,
      ttfbMs: typeof m.ttfbMs === 'number' ? m.ttfbMs : null,
      chatId: m.chatId || null,
      occurrences: Number(m.occurrences || 1),
      metadata: m,
    };
  }

  function buildWhere({ id, from, to, category, model, user, q } = {}) {
    const and = [{ action: ACTION }];
    if (id) and.push({ id: String(id).slice(0, 64) });
    const createdAt = {};
    if (from) { const d = new Date(from); if (Number.isFinite(d.getTime())) createdAt.gte = d; }
    if (to) { const d = new Date(to); if (Number.isFinite(d.getTime())) createdAt.lte = d; }
    if (Object.keys(createdAt).length) and.push({ createdAt });
    if (category) and.push({ metadata: { path: ['category'], equals: String(category) } });
    if (model) and.push({ metadata: { path: ['modelLabel'], equals: String(model) } });
    if (user) {
      const u = String(user).trim();
      and.push({ OR: [{ actorId: u }, { actorName: { contains: u, mode: 'insensitive' } }] });
    }
    if (q && String(q).trim().length >= 2) {
      const term = String(q).trim().slice(0, 120);
      and.push({
        OR: [
          { actorName: { contains: term, mode: 'insensitive' } },
          { resourceId: { contains: term } },
          { metadata: { path: ['prompt'], string_contains: term } },
          { metadata: { path: ['cause'], string_contains: term } },
          { metadata: { path: ['whatUserSaw'], string_contains: term } },
        ],
      });
    }
    return { AND: and };
  }

  async function list(params = {}) {
    const client = db();
    const limit = Math.min(Math.max(Number(params.limit) || 25, 1), 200);
    const page = Math.max(Number(params.page) || 1, 1);
    const where = buildWhere(params);
    const [rows, total] = await Promise.all([
      client.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: (page - 1) * limit }),
      typeof client.auditLog.count === 'function' ? client.auditLog.count({ where }) : Promise.resolve(null),
    ]);
    return { items: rows.map(toItem), total, page, limit };
  }

  async function recent({ since } = {}) {
    const client = db();
    const serverTime = new Date(now()).toISOString();
    const sinceDate = since ? new Date(since) : null;
    if (!sinceDate || !Number.isFinite(sinceDate.getTime())) {
      return { serverTime, count: 0, items: [] };
    }
    // 2 s overlap: a row committed just after the previous poll is never
    // lost; the client de-duplicates by id.
    const where = { action: ACTION, createdAt: { gt: new Date(sinceDate.getTime() - 2000) } };
    const [rows, count] = await Promise.all([
      client.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 20 }),
      typeof client.auditLog.count === 'function' ? client.auditLog.count({ where }) : Promise.resolve(0),
    ]);
    return {
      serverTime,
      count,
      items: rows.map((row) => {
        const item = toItem(row);
        return {
          id: item.id,
          createdAt: item.createdAt,
          category: item.category,
          categoryLabel: item.categoryLabel,
          severity: item.severity,
          sound: item.sound,
          cause: item.cause,
          userEmail: item.userEmail,
          model: item.model,
        };
      }),
    };
  }

  async function totalTurnsSince(sinceMs) {
    const t = now();
    if (totalTurnsCache.value != null && t - totalTurnsCache.at < 60_000 && totalTurnsCache.since === sinceMs) {
      return totalTurnsCache.value;
    }
    try {
      const client = db();
      if (!client.message || typeof client.message.count !== 'function') return null;
      const value = await client.message.count({ where: { role: 'USER', timestamp: { gte: new Date(sinceMs) } } });
      totalTurnsCache = { at: t, since: sinceMs, value };
      return value;
    } catch (_) {
      return null;
    }
  }

  function groupCauses(items, fromMs, toMs, prevFromMs) {
    const current = new Map();
    const previous = new Map();
    for (const it of items) {
      const t = Date.parse(it.createdAt);
      const key = it.fingerprint || `${it.category}|${it.cause}`;
      if (t >= fromMs && t <= toMs) {
        let g = current.get(key);
        if (!g) {
          g = { fingerprint: key, cause: it.cause, category: it.category, categoryLabel: it.categoryLabel, severity: it.severity, count: 0, users: new Set(), examples: [], models: new Map(), lastAt: it.createdAt };
          current.set(key, g);
        }
        g.count += Math.max(1, it.occurrences || 1);
        if (it.userId || it.userEmail) g.users.add(it.userId || it.userEmail);
        if (g.examples.length < 5) g.examples.push({ id: it.id, createdAt: it.createdAt, userEmail: it.userEmail, prompt: it.prompt ? String(it.prompt).slice(0, 140) : null });
        if (it.model) g.models.set(it.model, (g.models.get(it.model) || 0) + 1);
        if (Date.parse(g.lastAt) < t) g.lastAt = it.createdAt;
      } else if (t >= prevFromMs && t < fromMs) {
        previous.set(key, (previous.get(key) || 0) + Math.max(1, it.occurrences || 1));
      }
    }
    return Array.from(current.values())
      .map((g) => {
        const prev = previous.get(g.fingerprint) || 0;
        return {
          fingerprint: g.fingerprint,
          cause: g.cause,
          category: g.category,
          categoryLabel: g.categoryLabel,
          severity: g.severity,
          count: g.count,
          previousCount: prev,
          trendPct: prev > 0 ? Math.round(((g.count - prev) / prev) * 100) : null,
          isNew: prev === 0,
          affectedUsers: g.users.size,
          topModels: Array.from(g.models.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([model, count]) => ({ model, count })),
          lastAt: g.lastAt,
          examples: g.examples,
        };
      })
      .sort((a, b) => b.count - a.count || rankOf(b.severity) - rankOf(a.severity))
      .slice(0, 25);
  }

  async function stats() {
    const client = db();
    const t = now();
    const DAY = 24 * 60 * 60 * 1000;
    const rows = await client.auditLog.findMany({
      where: { action: ACTION, createdAt: { gte: new Date(t - 14 * DAY) } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
      select: { id: true, createdAt: true, actorId: true, actorName: true, resourceId: true, metadata: true },
    });
    const items = rows.map(toItem);
    const inWindow = (ms) => items.filter((it) => Date.parse(it.createdAt) >= t - ms);
    const lastHour = inWindow(60 * 60 * 1000);
    const last24h = inWindow(DAY);
    const last7d = inWindow(7 * DAY);
    const tally = (list, key) => {
      const map = new Map();
      for (const it of list) {
        const k = it[key] || '—';
        map.set(k, (map.get(k) || 0) + 1);
      }
      return Array.from(map.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    };
    const totalTurns24h = await totalTurnsSince(t - DAY);
    const failed24hTurns = last24h.length;
    return {
      serverTime: new Date(t).toISOString(),
      counts: { lastHour: lastHour.length, last24h: last24h.length, last7d: last7d.length },
      byCategory24h: tally(last24h, 'category').map((r) => ({ ...r, label: (CATEGORIES[r.name] && CATEGORIES[r.name].label) || r.name })),
      byModel24h: tally(last24h, 'model'),
      failureRate24h: {
        failed: failed24hTurns,
        total: totalTurns24h,
        pct: totalTurns24h ? Math.round((failed24hTurns / Math.max(totalTurns24h, failed24hTurns)) * 1000) / 10 : null,
      },
      topCauses: {
        '24h': groupCauses(items, t - DAY, t, t - 2 * DAY),
        '7d': groupCauses(items, t - 7 * DAY, t, t - 14 * DAY),
      },
    };
  }

  async function sweepExpired({ retentionDays = Number(process.env.SIRAGPT_TURN_FAILURE_RETENTION_DAYS || 30) } = {}) {
    const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 30;
    const client = db();
    if (!client || !client.auditLog || typeof client.auditLog.deleteMany !== 'function') return { deleted: 0 };
    const cutoff = new Date(now() - days * 24 * 60 * 60 * 1000);
    const res = await client.auditLog.deleteMany({ where: { action: ACTION, createdAt: { lt: cutoff } } });
    return { deleted: (res && res.count) || 0, cutoff: cutoff.toISOString() };
  }

  return {
    record,
    list,
    recent,
    stats,
    sweepExpired,
    toItem,
    _floodCheck: floodCheck,
  };
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function itemsToCsv(items = []) {
  const header = ['fecha', 'tipo', 'severidad', 'usuario', 'modelo', 'ruta', 'pregunta', 'que_vio_el_usuario', 'causa', 'duracion_ms', 'ttfb_ms', 'chat_id', 'req_ids', 'ocurrencias'];
  const lines = [header.join(',')];
  for (const it of items) {
    const m = it.metadata || {};
    lines.push([
      it.createdAt,
      it.categoryLabel || it.category,
      it.severity,
      it.userEmail || it.userId,
      it.model,
      it.route,
      it.prompt,
      it.whatUserSaw,
      it.cause,
      it.totalMs,
      it.ttfbMs,
      it.chatId,
      Array.isArray(m.reqIds) ? m.reqIds.join(' ') : '',
      it.occurrences,
    ].map(csvEscape).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = {
  ACTION,
  RESOURCE_TYPE,
  createTurnFailureStore,
  mergeMetadata,
  itemsToCsv,
  redact,
  sanitizeDeep,
};
