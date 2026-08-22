'use strict';
const express = require('express');
const Docker = require('dockerode');
const http = require('http');
const httpProxy = require('http-proxy');
const crypto = require('crypto');

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
const PORT = Number(process.env.PORT || 8090);
const BIND = process.env.BIND || '0.0.0.0';
const IMAGE = process.env.COMPUTER_IMAGE || 'siragpt-computer:local';
const NETWORK = process.env.COMPUTER_NETWORK || 'siragpt_agent_computer';
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:8090';
const EPHEMERAL_TTL_MS = Number(process.env.EPHEMERAL_TTL_MS || 30 * 60 * 1000);
const MEM_BYTES = 2 * 1024 * 1024 * 1024;
const NANO_CPUS = 2 * 1e9;
const SHM = 1024 * 1024 * 1024;
const API_KEY = process.env.AGENT_COMPUTER_API_KEY || '';

const sessions = new Map();
const ownerLocks = new Map();
const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
proxy.on('error', (err, _req, res) => {
  if (res && !res.headersSent && res.writeHead) res.writeHead(502, { 'Content-Type': 'application/json' });
  if (res && res.end) res.end(JSON.stringify({ error: 'proxy_error', message: String(err && err.message || err) }));
});

function authorized(req) {
  if (!API_KEY) return true;
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const want = Buffer.from(API_KEY);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function safeUserId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'anon';
}
function ownerName(userId) {
  return 'sira-ac-user-' + userId;
}
function urlsFor(id) {
  const base = PUBLIC_BASE.replace(/\/$/, '');
  return {
    sessionId: id,
    novncUrl: base + '/sessions/' + id + '/novnc/vnc.html?autoconnect=1&resize=scale&path=' + 'sessions/' + id + '/novnc/websockify',
    novncWsUrl: base.replace(/^http/, 'ws') + '/sessions/' + id + '/novnc/websockify',
    agentUrl: base + '/sessions/' + id + '/agent',
    cdpUrl: base + '/sessions/' + id + '/cdp',
  };
}

function isConflict(err) {
  const status = Number(err && (err.statusCode || err.status || err.statusCode));
  const msg = String(err && err.message || err || '');
  return status === 409 || /already in use|Conflict/i.test(msg);
}

function conflictContainerId(err) {
  const msg = String(err && err.message || err || '');
  const m = msg.match(/already in use by container "([a-f0-9]+)"/i);
  return m ? m[1] : null;
}

async function withOwnerLock(userId, fn) {
  const prev = ownerLocks.get(userId) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const next = prev.catch(() => {}).then(() => gate);
  ownerLocks.set(userId, next);
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    if (ownerLocks.get(userId) === next) ownerLocks.delete(userId);
  }
}

async function ensureNetwork() {
  const nets = await docker.listNetworks({ filters: { name: [NETWORK] } });
  if (nets.length) return;
  await docker.createNetwork({ Name: NETWORK, CheckDuplicate: true });
}

async function findByLabel(key, value) {
  const list = await docker.listContainers({ all: true, filters: { label: ['siragpt.agent-computer=1', key + '=' + value] } });
  return list[0] || null;
}

async function findByName(name) {
  const list = await docker.listContainers({ all: true, filters: { name: [name] } });
  const wantSlash = name.startsWith('/') ? name : '/' + name;
  const exact = list.find((c) => (c.Names || []).some((n) => n === wantSlash || n === name));
  return exact || null;
}

async function startIfStopped(container) {
  const info = await container.inspect();
  if (info.State && info.State.Running) return info;
  try {
    await container.start();
  } catch (err) {
    const status = Number(err && (err.statusCode || err.status));
    const msg = String(err && err.message || err || '');
    if (status !== 304 && !/already started|not modified/i.test(msg)) throw err;
  }
  return container.inspect();
}

function remember(meta) {
  sessions.set(meta.sessionId, meta);
  return meta;
}

async function adoptContainer(ref, userId, kind) {
  const id = typeof ref === 'string' ? ref : (ref && (ref.Id || ref.id));
  if (!id) throw new Error('adopt_missing_id');
  const container = docker.getContainer(id);
  const info = await startIfStopped(container);
  const labels = (info.Config && info.Config.Labels) || {};
  const sid = labels['siragpt.sessionId'] || crypto.randomUUID();
  const name = String(info.Name || '').replace(/^\//, '');
  return remember({
    sessionId: sid,
    containerId: info.Id,
    name,
    kind: labels['siragpt.kind'] || kind || 'owner',
    userId: labels['siragpt.userId'] || userId || '',
    expiresAt: null,
  });
}

async function createMachine(opts) {
  const userId = safeUserId(opts.userId);
  const kind = opts.kind === 'ephemeral' ? 'ephemeral' : 'owner';
  const sessionId = opts.sessionId || crypto.randomUUID();
  await ensureNetwork();
  const name = kind === 'owner' ? ownerName(userId) : ('sira-ac-eph-' + sessionId.slice(0, 8));
  const existing = await findByName(name);
  if (existing) {
    const meta = await adoptContainer(existing, userId, kind);
    return { reused: true, meta };
  }
  const labels = { 'siragpt.agent-computer': '1', 'siragpt.sessionId': sessionId, 'siragpt.kind': kind, 'siragpt.userId': userId };
  const hostConfig = { Memory: MEM_BYTES, NanoCpus: NANO_CPUS, ShmSize: SHM, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false, NetworkMode: NETWORK, RestartPolicy: { Name: kind === 'owner' ? 'always' : 'no' } };
  if (kind === 'owner') hostConfig.Binds = ['sira-ac-ws-' + userId + ':/workspace'];
  let container;
  try {
    container = await docker.createContainer({ Image: IMAGE, name: name, Labels: labels, HostConfig: hostConfig, Env: ['DISPLAY=:1'] });
  } catch (err) {
    if (isConflict(err)) {
      const byName = await findByName(name);
      const byId = conflictContainerId(err);
      const meta = await adoptContainer(byName || byId, userId, kind);
      return { reused: true, meta };
    }
    throw err;
  }
  await startIfStopped(container);
  const info = await container.inspect();
  const meta = remember({ sessionId, containerId: info.Id, name, kind, userId, expiresAt: kind === 'ephemeral' ? Date.now() + EPHEMERAL_TTL_MS : null });
  return { reused: false, meta, container };
}

async function inspectSession(containerId) {
  const c = docker.getContainer(containerId);
  const info = await c.inspect();
  return info;
}
async function destroyEphemeral(id) {
  const meta = sessions.get(id);
  if (meta && meta.kind === 'owner') { const e = new Error('owner_protected'); e.code = 'owner_protected'; throw e; }
  sessions.delete(id);
  try {
    let cid = meta && meta.containerId;
    if (!cid) {
      const found = await findByLabel('siragpt.sessionId', id);
      cid = found && found.Id;
    }
    if (!cid) return;
    const c = docker.getContainer(cid);
    try { await c.stop({ t: 5 }); } catch (_) {}
    try { await c.remove({ force: true }); } catch (_) {}
  } catch (_) {}
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, meta] of sessions) {
    if (meta.kind !== 'ephemeral') continue;
    if (meta.expiresAt && meta.expiresAt <= now) {
      try { await destroyEphemeral(id); } catch (_) {}
    }
  }
}, 30000).unref();

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res) => {
  let dockerOk = false;
  try { await docker.ping(); dockerOk = true; } catch (_) {}
  res.json({ ok: true, service: 'siragpt-computer-orchestrator', docker: dockerOk, image: IMAGE, sessions: sessions.size });
});

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

async function getOrCreateOwner(userId) {
  return withOwnerLock(userId, async () => {
    const name = ownerName(userId);
    const byName = await findByName(name);
    if (byName) return { meta: await adoptContainer(byName, userId, 'owner'), reused: true };
    const byLabel = await findByLabel('siragpt.userId', userId);
    if (byLabel) return { meta: await adoptContainer(byLabel, userId, 'owner'), reused: true };
    try {
      const created = await createMachine({ userId, kind: 'owner' });
      return { meta: created.meta, reused: Boolean(created.reused) };
    } catch (err) {
      if (isConflict(err)) {
        const again = await findByName(name);
        const byId = conflictContainerId(err);
        if (again || byId) return { meta: await adoptContainer(again || byId, userId, 'owner'), reused: true };
      }
      throw err;
    }
  });
}

app.post('/sessions', async (req, res) => {
  try {
    const body = req.body || {};
    const ephemeral = body.kind === 'ephemeral' || body.test === true;
    const kind = ephemeral ? 'ephemeral' : 'owner';
    const userId = safeUserId(body.userId || (kind === 'owner' ? 'default' : 'ci'));
    if (kind === 'owner') {
      const { meta, reused } = await getOrCreateOwner(userId);
      return res.status(reused ? 200 : 201).json({ ...urlsFor(meta.sessionId), kind: 'owner', userId: meta.userId || userId, reused: Boolean(reused) });
    }
    const created = await createMachine({ userId, kind });
    res.status(created.reused ? 200 : 201).json({
      ...urlsFor(created.meta.sessionId),
      kind,
      userId,
      reused: Boolean(created.reused),
      ttlMs: kind === 'ephemeral' ? EPHEMERAL_TTL_MS : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'create_failed', message: String(err && err.message || err) });
  }
});

async function loadMeta(id) {
  if (sessions.has(id)) return sessions.get(id);
  const found = await findByLabel('siragpt.sessionId', id);
  if (!found) return null;
  const info = await docker.getContainer(found.Id).inspect();
  const labels = info.Config.Labels || {};
  const meta = { sessionId: id, containerId: found.Id, name: info.Name.replace(/^\//,''), kind: labels['siragpt.kind'] || 'owner', userId: labels['siragpt.userId'] || '', expiresAt: null };
  remember(meta);
  return meta;
}

app.get('/sessions/:id', async (req, res) => {
  const meta = await loadMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'session_not_found' });
  if (meta.kind === 'ephemeral' && meta.expiresAt) meta.expiresAt = Date.now() + EPHEMERAL_TTL_MS;
  res.json({ ...urlsFor(meta.sessionId), kind: meta.kind, userId: meta.userId, expiresAt: meta.expiresAt || null });
});

app.post('/sessions/:id/renew', async (req, res) => {
  const meta = await loadMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'session_not_found' });
  if (meta.kind === 'ephemeral') meta.expiresAt = Date.now() + EPHEMERAL_TTL_MS;
  res.json({ ok: true, kind: meta.kind, expiresAt: meta.expiresAt || null });
});

app.delete('/sessions/:id', async (req, res) => {
  const meta = await loadMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'session_not_found' });
  if (meta.kind === 'owner' && req.query.force !== '1') return res.status(409).json({ error: 'owner_protected', message: 'owner machine stays up; pass force=1 only for emergency' });
  if (meta.kind === 'owner') return res.status(409).json({ error: 'owner_protected' });
  await destroyEphemeral(meta.sessionId);
  res.json({ ok: true });
});

async function containerBase(meta, port) {
  const info = await docker.getContainer(meta.containerId).inspect();
  const nets = info.NetworkSettings.Networks || {};
  const ip = ((nets[NETWORK] || Object.values(nets)[0] || {}).IPAddress);
  if (!ip) throw new Error('no_ip');
  return 'http://' + ip + ':' + port;
}

function mountProxy(prefix, port) {
  app.use(prefix, async (req, res) => {
    try {
      const meta = await loadMeta(req.params.id);
      if (!meta) return res.status(404).json({ error: 'session_not_found' });
      if (meta.kind === 'ephemeral' && meta.expiresAt) meta.expiresAt = Date.now() + EPHEMERAL_TTL_MS;
      const target = await containerBase(meta, port);
      proxy.web(req, res, { target });
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ error: 'proxy_failed', message: String(err && err.message || err) });
    }
  });
}
mountProxy('/sessions/:id/novnc', 6080);
mountProxy('/sessions/:id/agent', 8080);
mountProxy('/sessions/:id/cdp', 9222);

const server = http.createServer(app);
server.on('upgrade', async (req, socket, head) => {
  try {
    const m = String(req.url || '').match(/^\/sessions\/([^/]+)\/(novnc|agent|cdp)/);
    if (!m) return socket.destroy();
    const meta = await loadMeta(m[1]);
    if (!meta) return socket.destroy();
    const port = m[2] === 'novnc' ? 6080 : (m[2] === 'agent' ? 8080 : 9222);
    const target = await containerBase(meta, port);
    req.url = req.url.replace(/^\/sessions\/[^/]+\/(novnc|agent|cdp)/, '') || '/';
    proxy.ws(req, socket, head, { target });
  } catch (_) { try { socket.destroy(); } catch (__) {} }
});

async function adoptExisting() {
  const labeled = await docker.listContainers({ all: true, filters: { label: ['siragpt.agent-computer=1'] } }).catch(() => []);
  const seen = new Set();
  for (const c of labeled) {
    const labels = c.Labels || {};
    const sid = labels['siragpt.sessionId'] || crypto.randomUUID();
    seen.add(c.Id);
    remember({ sessionId: sid, containerId: c.Id, name: (c.Names && c.Names[0] || '').replace(/^\//,''), kind: labels['siragpt.kind'] || 'owner', userId: labels['siragpt.userId'] || '', expiresAt: null });
  }
  const named = await docker.listContainers({ all: true, filters: { name: ['sira-ac-user-'] } }).catch(() => []);
  for (const c of named) {
    if (seen.has(c.Id)) continue;
    const n = (c.Names && c.Names[0] || '').replace(/^\//, '');
    if (!/^sira-ac-user-/.test(n)) continue;
    const labels = c.Labels || {};
    const userId = labels['siragpt.userId'] || n.replace(/^sira-ac-user-/, '');
    remember({ sessionId: labels['siragpt.sessionId'] || crypto.randomUUID(), containerId: c.Id, name: n, kind: labels['siragpt.kind'] || 'owner', userId, expiresAt: null });
  }
}

adoptExisting().finally(() => {
  server.listen(PORT, BIND, () => console.log('[computer-orch] listen', BIND + ':' + PORT, 'image', IMAGE));
});
