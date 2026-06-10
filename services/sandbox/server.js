'use strict';

/**
 * SiraGPT sandbox microservice — the document-task "muscle".
 *
 * Runs on a dedicated host (the Lenovo) with Docker. The main SiraGPT app
 * (on Replit) drives it over HTTPS through a Cloudflare Tunnel: it creates a
 * session (= one ephemeral, network-less container), runs the five tool
 * primitives inside it, collects the produced files, and destroys the session.
 *
 * Endpoints (all JSON; Bearer SANDBOX_API_KEY required EXCEPT /health):
 *   GET    /health                         → liveness + capacity (no auth)
 *   POST   /v1/sessions                     → { sessionId, ttlMs }
 *   POST   /v1/sessions/:id/exec            { command, timeoutMs }
 *   POST   /v1/sessions/:id/put             { path, contentBase64 }
 *   POST   /v1/sessions/:id/read            { path } → { contentBase64 }
 *   POST   /v1/sessions/:id/write           { path, contentBase64 }
 *   POST   /v1/sessions/:id/list            { path } → { files }
 *   GET    /v1/sessions/:id/outputs         → { outputs:[{name,contentBase64}] }
 *   DELETE /v1/sessions/:id                 → { ok }
 *
 * Capacity: SANDBOX_MAX_CONCURRENCY (default 15) live containers; create
 * returns 429 when full. Sessions auto-expire after SANDBOX_SESSION_TTL_MS
 * (default 10 min); a GC sweeps + destroys expired ones.
 *
 * Zero npm dependencies — built on Node's http — so the standalone deploy is
 * just `node server.js` (systemd). Binds to SANDBOX_BIND (default 127.0.0.1).
 */

const http = require('http');
const crypto = require('crypto');
const { createDockerSession, dockerAvailable, IMAGE, limits } = require('./lib/docker-sandbox');

const PORT = Number(process.env.SANDBOX_PORT || 4000);
const BIND = process.env.SANDBOX_BIND || '127.0.0.1';
const API_KEY = process.env.SANDBOX_API_KEY || '';
const MAX_CONCURRENCY = clampInt(process.env.SANDBOX_MAX_CONCURRENCY, 15, 1, 64);
const SESSION_TTL_MS = clampInt(process.env.SANDBOX_SESSION_TTL_MS, 10 * 60_000, 30_000, 60 * 60_000);
const MAX_BODY_BYTES = clampInt(process.env.SANDBOX_MAX_BODY_BYTES, 64 * 1024 * 1024, 64 * 1024, 256 * 1024 * 1024);

function clampInt(v, fb, min, max) { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fb; }

if (!API_KEY) {
  // eslint-disable-next-line no-console
  console.error('FATAL: SANDBOX_API_KEY is not set. Refusing to start an unauthenticated sandbox.');
  process.exit(1);
}

/** sessionId → { session, expiresAt } */
const sessions = new Map();

function authorized(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const want = Buffer.from(API_KEY);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY_BYTES) { reject(new Error('payload too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function touch(entry) { entry.expiresAt = Date.now() + SESSION_TTL_MS; }

async function destroySession(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  sessions.delete(id);
  try { await entry.session.destroy(); } catch (_) {}
}

// TTL garbage collector.
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (entry.expiresAt <= now) destroySession(id);
  }
}, 30_000).unref();

/**
 * Build the HTTP server. The session factory + docker probe are injectable so
 * the full remote pipeline can be tested offline (no Docker) with a fake
 * session; production uses the real ephemeral-container factory.
 */
function buildServer({ createSession = createDockerSession, isDockerAvailable = dockerAvailable } = {}) {
  return http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    // ── /health (no auth) ──
    if (req.method === 'GET' && url.pathname === '/health') {
      const dockerOk = await isDockerAvailable();
      return send(res, 200, {
        ok: true,
        service: 'siragpt-sandbox',
        docker: dockerOk,
        image: IMAGE,
        activeSessions: sessions.size,
        maxConcurrency: MAX_CONCURRENCY,
        limits,
      });
    }

    // ── everything else requires Bearer ──
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

    // POST /v1/sessions
    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      if (sessions.size >= MAX_CONCURRENCY) return send(res, 429, { error: 'at_capacity', maxConcurrency: MAX_CONCURRENCY });
      if (!(await isDockerAvailable())) return send(res, 503, { error: 'docker_unavailable' });
      const session = await createSession();
      const id = crypto.randomUUID();
      sessions.set(id, { session, expiresAt: Date.now() + SESSION_TTL_MS });
      return send(res, 201, { sessionId: id, ttlMs: SESSION_TTL_MS });
    }

    // /v1/sessions/:id/*
    if (parts[0] === 'v1' && parts[1] === 'sessions' && parts[2]) {
      const id = parts[2];
      const entry = sessions.get(id);
      const action = parts[3];

      if (req.method === 'DELETE' && !action) { await destroySession(id); return send(res, 200, { ok: true }); }
      if (!entry) return send(res, 404, { error: 'session_not_found' });
      touch(entry);
      const s = entry.session;

      if (req.method === 'GET' && action === 'outputs') {
        const outputs = await s.collectOutputs();
        return send(res, 200, { outputs: outputs.map((o) => ({ name: o.name, contentBase64: o.buffer.toString('base64') })) });
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (action === 'exec') {
          const r = await s.exec(String(body.command || ''), { timeoutMs: body.timeoutMs });
          return send(res, 200, r);
        }
        if (action === 'put') {
          const p = await s.putFile(String(body.path || ''), Buffer.from(String(body.contentBase64 || ''), 'base64'));
          return send(res, 200, { ok: true, path: p });
        }
        if (action === 'write') {
          await s.writeFile(String(body.path || ''), Buffer.from(String(body.contentBase64 || ''), 'base64'));
          return send(res, 200, { ok: true });
        }
        if (action === 'read') {
          const buf = await s.readFile(String(body.path || ''));
          return send(res, 200, { contentBase64: buf.toString('base64') });
        }
        if (action === 'list') {
          const files = await s.listFiles(String(body.path || '.') || '.');
          return send(res, 200, { files });
        }
      }
    }

    return send(res, 404, { error: 'not_found' });
  } catch (err) {
    return send(res, 500, { error: 'internal', message: String(err && err.message || err) });
  }
  });
}

const server = buildServer();

function shutdown() {
  // eslint-disable-next-line no-console
  console.log('[sandbox] shutting down — destroying live sessions');
  Promise.allSettled([...sessions.keys()].map(destroySession)).finally(() => { try { server.close(); } catch (_) {} process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) {
  server.listen(PORT, BIND, () => {
    // eslint-disable-next-line no-console
    console.log(`[sandbox] listening on ${BIND}:${PORT} — image=${IMAGE} maxConcurrency=${MAX_CONCURRENCY} ttl=${SESSION_TTL_MS}ms`);
  });
}

module.exports = { server, buildServer, sessions, authorized, _internal: { destroySession } };
