'use strict';

/**
 * Admin → Logs → «Registros en vivo» handlers.
 *
 * Mounted inside the admin router (src/routes/admin.js) so they inherit
 * authenticateToken + the declarative admin route policy (audit.read):
 *
 *   GET /api/admin/logs/live               SSE: backfill, then live tail + heartbeat
 *   GET /api/admin/logs/search             history (newest first, cursor `before`)
 *   GET /api/admin/logs/request/:reqId     every line of one request/turn, in order
 *
 * The live stream uses fetch streaming on the client (Bearer header) — never
 * EventSource, so no token ever travels in a URL.
 */

const liveLogs = require('../services/observability/live-logs');
const { levelRank } = require('../services/observability/live-logs/classify');

const MAX_CLIENTS = 25;
const FLUSH_MS = 300;
const HEARTBEAT_MS = 15_000;
const MAX_QUEUE = 3000;
const SAFE_REQ_ID = /^[A-Za-z0-9._~:/+=@-]{1,128}$/;
const activeClients = new Set();

const LEVEL_ALIASES = Object.freeze({
  all: null,
  todo: null,
  todos: null,
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  aviso: 'warn',
  avisos: 'warn',
  error: 'error',
  errores: 'error',
  fatal: 'fatal',
});

function str(v, max = 200) {
  if (Array.isArray(v)) v = v[0];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function parseFilter(query = {}) {
  const levelKey = (str(query.level, 20) || 'all').toLowerCase();
  const minLevel = Object.prototype.hasOwnProperty.call(LEVEL_ALIASES, levelKey) ? LEVEL_ALIASES[levelKey] : null;
  const toMs = (v) => {
    const s = str(v, 40);
    if (!s) return null;
    const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    minLevel,
    source: str(query.source, 60),
    q: str(query.q, 200),
    user: str(query.user, 120),
    reqId: str(query.reqId, 128),
    chatId: str(query.chatId, 64),
    from: toMs(query.from),
    to: toMs(query.to),
  };
}

function intParam(v, fallback, min, max) {
  const n = Number.parseInt(Array.isArray(v) ? v[0] : v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

async function live(req, res) {
  if (activeClients.size >= MAX_CLIENTS) {
    return res.status(429).json({ error: 'too_many_streams', message: 'Demasiadas pestañas de registros abiertas. Cierra alguna e inténtalo de nuevo.' });
  }
  const store = liveLogs.getStore();
  const filter = parseFilter(req.query);
  const match = store.matcher(filter);
  const backfill = intParam(req.query.backfill, 300, 0, 1000);
  const after = str(req.query.after, 40);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  // no-transform keeps the compression middleware (and proxies) from buffering.
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof req.setTimeout === 'function') req.setTimeout(0);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  const queue = [];
  const repeats = new Map();
  const sentIds = new Set();
  let dropped = 0;

  const write = (event, data) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    } catch (_) {
      cleanup();
    }
  };
  const remember = (lines) => {
    for (const l of lines) {
      sentIds.add(l.id);
      if (sentIds.size > 5000) sentIds.delete(sentIds.values().next().value);
    }
  };

  const onLine = (event) => {
    if (closed || !match(event)) return;
    queue.push(event);
    if (queue.length > MAX_QUEUE) {
      const extra = queue.length - MAX_QUEUE;
      queue.splice(0, extra);
      dropped += extra;
    }
  };
  const onRepeat = (update) => {
    if (!closed && sentIds.has(update.id)) repeats.set(update.id, update);
  };

  const flushTimer = setInterval(() => {
    if (queue.length) {
      const batch = queue.splice(0, 500);
      remember(batch);
      write('lines', batch);
    }
    if (repeats.size) {
      write('repeat', [...repeats.values()]);
      repeats.clear();
    }
  }, FLUSH_MS);
  const heartbeat = setInterval(() => {
    write('ping', { now: Date.now(), dropped, stats: store.snapshot() });
  }, HEARTBEAT_MS);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(flushTimer);
    clearInterval(heartbeat);
    store.bus.off('line', onLine);
    store.bus.off('repeat', onRepeat);
    activeClients.delete(res);
  }
  activeClients.add(res);
  req.on('close', cleanup);
  res.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);

  // Subscribe BEFORE reading the backfill so nothing falls between the two.
  store.bus.on('line', onLine);
  store.bus.on('repeat', onRepeat);

  write('hello', { now: Date.now(), stats: store.snapshot(), filter });

  let initial = after
    ? store.recent(filter, { limit: 2000, afterId: after })
    : store.recent(filter, { limit: backfill });
  if (!after && initial.length < backfill) {
    try {
      const hist = await store.search(filter, { limit: backfill });
      const seen = new Set(initial.map((l) => l.id));
      const older = hist.lines.filter((l) => !seen.has(l.id)).reverse();
      initial = [...older, ...initial].slice(-backfill);
    } catch (_) { /* ring buffer only */ }
  }
  const initialIds = new Set(initial.map((l) => l.id));
  // Lines captured while the backfill was being read may already be queued.
  for (let i = queue.length - 1; i >= 0; i -= 1) if (initialIds.has(queue[i].id)) queue.splice(i, 1);
  for (let i = 0; i < initial.length; i += 200) {
    const chunk = initial.slice(i, i + 200);
    remember(chunk);
    write('backfill', chunk);
  }
  write('ready', { count: initial.length });
  return undefined;
}

async function search(req, res) {
  try {
    const filter = parseFilter(req.query);
    const limit = intParam(req.query.limit, 200, 1, 1000);
    const before = str(req.query.before, 40);
    const result = await liveLogs.getStore().search(filter, { limit, before });
    return res.json(result);
  } catch (err) {
    console.error('[admin/logs/search] failed:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'search_failed' });
  }
}

function summarize(lines) {
  const levels = {};
  const users = new Set();
  const routes = new Set();
  const chatIds = new Set();
  for (const l of lines) {
    levels[l.level] = (levels[l.level] || 0) + (l.repeat || 1);
    if (l.email || l.userId) users.add(l.email || l.userId);
    if (l.route) routes.add(l.route);
    if (l.chatId) chatIds.add(l.chatId);
  }
  const first = lines[0];
  const last = lines[lines.length - 1];
  return {
    count: lines.length,
    firstTs: first ? first.ts : null,
    lastTs: last ? (last.lastTs || last.ts) : null,
    durationMs: first && last ? Math.max(0, (last.lastTs || last.ts) - first.ts) : null,
    levels,
    errors: lines.filter((l) => levelRank(l.level) >= levelRank('error')).length,
    users: [...users].slice(0, 5),
    routes: [...routes].slice(0, 5),
    chatIds: [...chatIds].slice(0, 5),
  };
}

async function request(req, res) {
  const reqId = String(req.params.reqId || '').trim();
  if (!SAFE_REQ_ID.test(reqId)) return res.status(400).json({ error: 'invalid_request_id' });
  try {
    const limit = intParam(req.query.limit, 600, 1, 2000);
    const lines = await liveLogs.getRequestLogs(reqId, { limit });
    return res.json({ reqId, summary: summarize(lines), lines });
  } catch (err) {
    console.error('[admin/logs/request] failed:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'request_logs_failed' });
  }
}

module.exports = {
  live,
  search,
  request,
  parseFilter,
  summarize,
  _activeClients: activeClients,
};
