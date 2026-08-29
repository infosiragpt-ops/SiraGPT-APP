'use strict';

/**
 * siragpt-computer-orchestrator
 *
 * Contract consumed by backend/src/services/computer/orch-client.js
 * and backend/src/routes/agent-computer.js:
 *   POST /sessions { userId } → { sessionId, userId, reused }
 *   GET  /sessions/:id
 *   GET  /sessions/:id/novnc/...  (vnc.html + websockify)
 *   *    /sessions/:id/cdp        (Chrome DevTools HTTP/WS)
 *   POST /sessions/:id/agent/action
 *   GET  /sessions/:id/agent/screenshot
 */

const http = require('http');
const { createSessionStore, slugUserId, sessionIdFor, containerNameFor } = require('./session-store');
const { createDockerRuntime } = require('./docker-runtime');
const { buildActionCommand, screenshotCommand, actionType } = require('./agent-actions');
const { proxyHttp, proxyUpgrade, joinPath } = require('./http-proxy');

const ORCH_DOWN_ES = 'No se pudo abrir la computadora. El escritorio no está disponible.';
const DEFAULT_PORT = 8090;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error('payload too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) {
        err.status = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function authorize(req, env = process.env) {
  const secret = String(env.AGENT_COMPUTER_API_KEY || env.COMPUTER_ORCH_SECRET || '').trim();
  if (!secret) return true;
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return token === secret;
}

function publicUrls(session, env = process.env) {
  const id = session.sessionId;
  const listen = Number(env.PORT) > 0 ? Number(env.PORT) : DEFAULT_PORT;
  const internal = String(env.AGENT_COMPUTER_INTERNAL_BASE || `http://127.0.0.1:${listen}`).replace(/\/$/, '');
  return {
    ...session,
    cdpUrl: `${internal}/sessions/${id}/cdp`,
    agentUrl: `${internal}/sessions/${id}/agent`,
    novncPath: `/sessions/${id}/novnc/vnc.html`,
  };
}

function createOrchestrator(opts = {}) {
  const env = opts.env || process.env;
  const store = opts.store || createSessionStore();
  const driver = String(opts.driver || env.AGENT_COMPUTER_ORCH_DRIVER || 'docker').trim().toLowerCase();
  const maxDesktops = Number(env.AGENT_COMPUTER_MAX_DESKTOPS) > 0
    ? Number(env.AGENT_COMPUTER_MAX_DESKTOPS)
    : 2;
  const runtime = opts.runtime || (driver === 'fake' ? null : createDockerRuntime({
    image: env.AGENT_COMPUTER_DESKTOP_IMAGE,
    memoryMb: env.AGENT_COMPUTER_DESKTOP_MEMORY_MB,
    cpus: env.AGENT_COMPUTER_DESKTOP_CPUS,
    network: env.AGENT_COMPUTER_DOCKER_NETWORK,
    requestImpl: opts.dockerRequest,
    execImpl: opts.execImpl,
  }));

  function sessionPayload(row, extra = {}) {
    return publicUrls({
      sessionId: row.sessionId,
      userId: row.userId,
      reused: Boolean(row.reused),
      container: row.container,
      kind: 'persistent-desktop',
      ...extra,
    }, env);
  }

  async function ensureSession(userId) {
    const uid = slugUserId(userId);
    if (!uid || uid === 'member' && !String(userId || '').trim()) {
      const err = new Error('userId is required');
      err.status = 400;
      err.code = 'user_required';
      throw err;
    }
    const existing = store.getByUser(uid);
    if (existing && driver === 'fake') {
      existing.reused = true;
      return sessionPayload(existing);
    }

    if (driver === 'fake') {
      if (!existing && store.size() >= maxDesktops) {
        const err = new Error(ORCH_DOWN_ES);
        err.status = 429;
        err.code = 'desktop_cap';
        throw err;
      }
      const row = {
        sessionId: sessionIdFor(uid),
        userId: uid,
        container: containerNameFor(uid),
        reused: false,
        host: '127.0.0.1',
      };
      store.put(row);
      return sessionPayload(row);
    }

    if (!runtime) {
      const err = new Error(ORCH_DOWN_ES);
      err.status = 503;
      err.code = 'ORCH_UNAVAILABLE';
      throw err;
    }

    const container = containerNameFor(uid);
    const live = existing || { sessionId: sessionIdFor(uid), userId: uid, container };
    let ensured;
    try {
      ensured = await runtime.ensureContainer(container);
    } catch (err) {
      const wrapped = new Error(ORCH_DOWN_ES);
      wrapped.status = 503;
      wrapped.code = 'ORCH_UNAVAILABLE';
      wrapped.cause = err;
      throw wrapped;
    }
    const host = runtime.containerIp(ensured.info) || container;
    const row = {
      ...live,
      container,
      host,
      reused: Boolean(existing) || Boolean(ensured.reused),
    };
    store.put(row);
    return sessionPayload(row);
  }

  async function handleAction(session, body) {
    const type = actionType(body);
    const command = buildActionCommand(body);
    if (!command) {
      const err = new Error('unsupported_action');
      err.status = 400;
      err.code = 'computer_action_unsupported';
      throw err;
    }
    if (driver === 'fake' || typeof opts.execImpl === 'function' || (runtime && runtime.execIn)) {
      const exec = opts.execImpl || (runtime && runtime.execIn.bind(runtime));
      if (driver === 'fake' && !opts.execImpl) {
        if (type === 'screenshot') {
          return { ok: true, type, pngBase64: '', mime: 'image/png', bytes: 0, fake: true };
        }
        return { ok: true, type, fake: true };
      }
      const out = await exec(session.container, command, { timeoutMs: 20_000 });
      if (type === 'screenshot') {
        const b64 = String(out.stdout || '').trim();
        return { ok: true, type, pngBase64: b64, mime: 'image/png', bytes: Math.floor(b64.length * 0.75) };
      }
      return { ok: true, type, stdout: out.stdout, stderr: out.stderr };
    }
    return { ok: true, type };
  }

  async function handleScreenshot(session) {
    return handleAction(session, { type: 'screenshot' });
  }

  async function onRequest(req, res) {
    if (!authorize(req, env)) {
      return json(res, 401, { error: 'unauthorized', message: ORCH_DOWN_ES });
    }
    const url = new URL(req.url, 'http://orchestrator.local');
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      return json(res, 200, {
        ok: true,
        service: 'siragpt-computer-orchestrator',
        driver,
        sessions: store.size(),
      });
    }

    if (req.method === 'POST' && path === '/sessions') {
      try {
        const body = await readBody(req);
        const session = await ensureSession(body.userId || body.user || body.id);
        return json(res, session.reused ? 200 : 201, session);
      } catch (err) {
        return json(res, err.status || 500, {
          error: err.code || 'create_failed',
          message: err.status === 400 ? String(err.message) : ORCH_DOWN_ES,
        });
      }
    }

    const sessionMatch = path.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (!sessionMatch) {
      return json(res, 404, { error: 'not_found' });
    }
    const session = store.getById(sessionMatch[1]);
    if (!session) {
      return json(res, 404, { error: 'not_found', message: 'session missing' });
    }
    const rest = sessionMatch[2] || '';

    if (req.method === 'GET' && rest === '') {
      return json(res, 200, sessionPayload(session));
    }

    if (rest.startsWith('novnc')) {
      const sub = rest === 'novnc' || rest === 'novnc/' ? '/vnc.html' : rest.slice('novnc'.length);
      if (driver === 'fake') {
        if (req.method === 'GET' && /vnc\.html/.test(sub)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><title>noVNC</title><body>novnc fake</body>');
          return;
        }
        return json(res, 200, { ok: true, fake: true });
      }
      return proxyHttp(req, res, {
        hostname: session.host,
        port: 6080,
        path: joinPath('', sub || '/'),
        retries: 4,
        retryDelayMs: 250,
      });
    }

    if (rest === 'cdp' || rest.startsWith('cdp/')) {
      const sub = rest === 'cdp' ? '/' : rest.slice('cdp'.length);
      if (driver === 'fake') {
        return json(res, 200, { Browser: 'fake', webSocketDebuggerUrl: '' });
      }
      return proxyHttp(req, res, {
        hostname: session.host,
        port: 9222,
        path: sub || '/',
      });
    }

    if (rest === 'agent/action' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const out = await handleAction(session, body);
        return json(res, 200, out);
      } catch (err) {
        return json(res, err.status || 500, {
          error: err.code || 'action_failed',
          message: ORCH_DOWN_ES,
        });
      }
    }

    if (rest === 'agent/screenshot' && req.method === 'GET') {
      try {
        const out = await handleScreenshot(session);
        return json(res, 200, out);
      } catch (err) {
        return json(res, err.status || 500, {
          error: err.code || 'screenshot_failed',
          message: ORCH_DOWN_ES,
        });
      }
    }

    if (rest === 'agent/navigate' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const urlToOpen = String(body.url || body.href || '').trim();
        const cmd = `(google-chrome --no-sandbox --disable-dev-shm-usage --user-data-dir=/workspace/.chrome --no-first-run --disable-gpu --new-window ${JSON.stringify(urlToOpen)} || chromium --no-sandbox --disable-dev-shm-usage --new-window ${JSON.stringify(urlToOpen)} || xdg-open ${JSON.stringify(urlToOpen)}) >/tmp/sira-nav.log 2>&1 & echo Opening`;
        if (driver === 'fake' && !opts.execImpl) {
          return json(res, 200, { ok: true, url: urlToOpen, fake: true });
        }
        const exec = opts.execImpl || (runtime && runtime.execIn.bind(runtime));
        const out = exec ? await exec(session.container, cmd, { timeoutMs: 8000 }) : { stdout: 'Opening' };
        return json(res, 200, { ok: true, url: urlToOpen, stdout: out.stdout });
      } catch (err) {
        return json(res, err.status || 500, { error: 'navigate_failed', message: ORCH_DOWN_ES });
      }
    }

    return json(res, 404, { error: 'not_found' });
  }

  function onUpgrade(req, socket, head) {
    if (!authorize(req, env)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://orchestrator.local');
    const match = url.pathname.match(/^\/sessions\/([^/]+)\/(novnc|cdp)(\/.*)?$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const session = store.getById(match[1]);
    if (!session || driver === 'fake') {
      socket.destroy();
      return;
    }
    const kind = match[2];
    const rest = match[3] || (kind === 'novnc' ? '/websockify' : '/');
    if (kind === 'novnc') {
      return proxyUpgrade(req, socket, head, {
        hostname: session.host,
        port: 6080,
        path: rest === '/websockify' ? '/websockify' : rest,
      });
    }
    return proxyUpgrade(req, socket, head, {
      hostname: session.host,
      port: 9222,
      path: rest || '/',
    });
  }

  const server = http.createServer(onRequest);
  server.on('upgrade', onUpgrade);

  return {
    server,
    store,
    ensureSession,
    handleAction,
    onRequest,
    onUpgrade,
    driver,
  };
}

function listen(opts = {}) {
  const orch = createOrchestrator(opts);
  const port = Number((opts.env || process.env).PORT) > 0
    ? Number((opts.env || process.env).PORT)
    : DEFAULT_PORT;
  orch.server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({
      evt: 'computer_orchestrator_listen',
      port,
      driver: orch.driver,
    }));
  });
  return orch;
}

if (require.main === module) {
  listen();
}

module.exports = {
  createOrchestrator,
  listen,
  ORCH_DOWN_ES,
  DEFAULT_PORT,
};
