'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { DockerApi } = require('./runsc-sandbox-docker-api');
const { RunscSandboxService } = require('./runsc-sandbox-service');
const { FileActivityStore } = require('./runsc-sandbox-activity-store');
const {
  RunscSandboxError,
  parseControllerConfig,
  assertSandboxRef,
} = require('./runsc-sandbox-controller-utils');

const MAX_REQUEST_BYTES = 256 * 1024;

function tokenMatches(value, expected) {
  const match = /^Bearer\s+(.+)$/i.exec(String(value || ''));
  if (!match) return false;
  const supplied = Buffer.from(match[1], 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return supplied.length === wanted.length && crypto.timingSafeEqual(supplied, wanted);
}

function writeJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function readJson(req, maxBytes = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new RunscSandboxError('request_too_large', 'request body is too large', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('body must be an object');
        }
        resolve(parsed);
      } catch {
        reject(new RunscSandboxError('invalid_json', 'request body must be a JSON object', { status: 400 }));
      }
    });
  });
}

function createController({ service, config, logger = console } = {}) {
  if (!service || !config) throw new TypeError('service and config are required');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://runsc-controller.invalid');
      if (req.method === 'GET' && url.pathname === '/health') {
        try {
          await service.assertRuntimeAvailable();
          writeJson(res, 200, { ok: true, provider: 'runsc-workspace', runtime: 'runsc-systrap' });
        } catch {
          writeJson(res, 503, { ok: false, error: 'runtime_unavailable' });
        }
        return;
      }

      if (!url.pathname.startsWith('/v1/') || !tokenMatches(req.headers.authorization, config.token)) {
        writeJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/sandboxes') {
        const body = await readJson(req);
        const result = await service.ensure({ workspaceRef: body.workspaceRef, ttlMs: body.ttlMs });
        writeJson(res, 201, result);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/gc') {
        const result = await service.gc();
        writeJson(res, 200, result);
        return;
      }

      const workspaceMatch = /^\/v1\/workspaces\/([^/]+)(?:\/(stop))?$/.exec(url.pathname);
      if (workspaceMatch) {
        const workspaceRef = decodeURIComponent(workspaceMatch[1]);
        if (req.method === 'GET' && !workspaceMatch[2]) {
          writeJson(res, 200, await service.statusWorkspace(workspaceRef));
          return;
        }
        if (req.method === 'POST' && workspaceMatch[2] === 'stop') {
          writeJson(res, 200, await service.stopWorkspace(workspaceRef));
          return;
        }
        if (req.method === 'DELETE' && !workspaceMatch[2]) {
          writeJson(res, 200, await service.deleteWorkspace(workspaceRef));
          return;
        }
        writeJson(res, 405, { error: 'method_not_allowed' });
        return;
      }

      const match = /^\/v1\/sandboxes\/([^/]+)(?:\/(exec|stop))?$/.exec(url.pathname);
      if (!match) {
        writeJson(res, 404, { error: 'not_found' });
        return;
      }
      const sandboxRef = assertSandboxRef(decodeURIComponent(match[1]));
      const action = match[2] || null;
      if (req.method === 'GET' && action === null) {
        writeJson(res, 200, await service.status(sandboxRef));
        return;
      }
      if (req.method === 'POST' && action === 'exec') {
        const body = await readJson(req);
        writeJson(res, 200, await service.exec(sandboxRef, { argv: body.argv, timeoutMs: body.timeoutMs }));
        return;
      }
      if (req.method === 'POST' && action === 'stop') {
        writeJson(res, 200, await service.stop(sandboxRef));
        return;
      }
      if (req.method === 'DELETE' && action === null) {
        writeJson(res, 200, await service.delete(sandboxRef));
        return;
      }
      writeJson(res, 405, { error: 'method_not_allowed' });
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 500;
      const code = typeof error?.code === 'string' ? error.code : 'internal_error';
      if (status >= 500) logger.error?.('[runsc-sandbox-controller]', code);
      if (!res.headersSent) writeJson(res, status, { error: code, message: status < 500 ? error.message : 'sandbox controller failed closed' });
      else res.destroy();
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  return server;
}

async function startController(env = process.env) {
  const config = parseControllerConfig(env);
  const docker = new DockerApi({ socketPath: config.socketPath });
  const activityStore = new FileActivityStore({ directory: config.stateDir });
  await activityStore.initialize();
  const service = new RunscSandboxService({ docker, config, activityStore });
  await docker.ping();
  await service.assertRuntimeAvailable();
  await service.reconcileInterruptedExecs();
  await service.gc();

  const server = createController({ service, config });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', resolve);
  });
  const gcTimer = setInterval(() => {
    service.gc().catch((error) => console.error('[runsc-sandbox-controller] gc_failed', error?.code || 'unknown'));
  }, config.gcIntervalMs);
  gcTimer.unref();

  const shutdown = () => {
    clearInterval(gcTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.log(`[runsc-sandbox-controller] listening on ${config.port}`);
  return { server, service, config };
}

if (require.main === module) {
  startController().catch((error) => {
    console.error('[runsc-sandbox-controller] startup_failed', error?.code || 'unknown');
    process.exit(1);
  });
}

module.exports = {
  MAX_REQUEST_BYTES,
  tokenMatches,
  readJson,
  createController,
  startController,
};
