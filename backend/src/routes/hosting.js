'use strict';

/**
 * Publishing / deploy routes (Replit-style) — deploy a connected repo's build
 * to Hostinger (or any SFTP/FTP host). Mounts under /api/hosting.
 *
 *   GET    /targets                         list deploy targets (no secrets)
 *   POST   /targets                         create (tests connection first)
 *   PUT    /targets/:id                     update (re-seal creds if provided)
 *   DELETE /targets/:id                     remove
 *   POST   /targets/:id/test                connectivity check
 *   GET    /connected/:id/build-plan        detected build command + out dir
 *   POST   /connected/:id/deploy            build + upload → { deploymentId }
 *   GET    /connected/:id/deployments       history
 *   GET    /deployments/:deploymentId       status snapshot
 *   GET    /deployments/:deploymentId/logs  SSE live build + upload logs
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const connectedRepos = require('../repositories/ConnectedRepositoryRepository');
const workspaces = require('../repositories/WorkspaceRepository');
const workspaceManager = require('../services/github/workspace-manager');
const targets = require('../repositories/HostingTargetRepository');
const deployments = require('../repositories/DeploymentRepository');
const creds = require('../services/hosting/credentials');
const buildService = require('../services/hosting/build.service');
const deployService = require('../services/hosting/deploy.service');
const deployEnvs = require('../repositories/DeployEnvRepository');
const domain = require('../services/hosting/domain');
const { assertSafeRemoteHost } = require('../services/hosting/safety');

const router = express.Router();

const PROTOCOLS = new Set(['sftp', 'ftp', 'ftps']);

/** Resolve a connected repo + its cloned workspace for the caller, or throw. */
async function loadClonedWorkspace(req) {
  const connection = await connectedRepos.findByIdForUser(req.params.id, req.user.id);
  if (!connection) {
    const e = new Error('Connected repository not found');
    e.status = 404;
    e.code = 'not_found';
    throw e;
  }
  const workspace = await workspaces.findByRepositoryId(connection.id);
  if (!workspace || !workspaceManager.isGitRepo(workspace.localPath)) {
    const e = new Error('Repository is not cloned yet — clone it first');
    e.status = 409;
    e.code = 'not_cloned';
    throw e;
  }
  return { connection, workspace, localPath: workspace.localPath };
}

/** Strip secrets before returning a target to the client. */
function publicTarget(t) {
  const { encryptedCreds, ...rest } = t;
  return { ...rest, ...creds.credsSummary(encryptedCreds) };
}

function normalizeTargetBody(body = {}) {
  const protocol = PROTOCOLS.has(body.protocol) ? body.protocol : 'sftp';
  const out = {
    provider: body.provider ? String(body.provider).slice(0, 40) : 'hostinger',
    label: String(body.label || 'Hostinger').slice(0, 80),
    protocol,
    host: String(body.host || '').trim(),
    port: Number(body.port) || (protocol === 'sftp' ? 22 : 21),
    username: String(body.username || '').trim(),
    remoteBaseDir: String(body.remoteBaseDir || '/public_html').trim(),
    siteUrl: body.siteUrl ? String(body.siteUrl).trim() : null,
  };
  return out;
}

// ── Targets ───────────────────────────────────────────────────────

router.get('/targets', authenticateToken, async (req, res) => {
  try {
    const list = await targets.listForUser(req.user.id);
    return res.json({ targets: list.map(publicTarget) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list targets' });
  }
});

router.post('/targets', authenticateToken, async (req, res) => {
  try {
    const data = normalizeTargetBody(req.body);
    if (!data.host || !data.username) {
      return res.status(400).json({ error: 'host and username are required', code: 'invalid_input' });
    }
    const credBundle = {
      password: req.body && req.body.password,
      privateKey: req.body && req.body.privateKey,
      passphrase: req.body && req.body.passphrase,
    };
    if (!credBundle.password && !credBundle.privateKey) {
      return res.status(400).json({ error: 'A password or private key is required', code: 'no_credentials' });
    }
    // SECURITY: refuse internal/reserved hosts (SSRF) before connecting.
    try {
      await assertSafeRemoteHost(data.host);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message, code: e.code || 'host_blocked' });
    }
    // Verify the connection before persisting.
    const transport = deployService.transportFor(data.protocol);
    try {
      await transport.testConnection({ ...data, ...credBundle });
    } catch (e) {
      return res.status(400).json({ error: `Connection test failed: ${e.message}`, code: 'connect_failed' });
    }
    const created = await targets.create(req.user.id, {
      ...data,
      encryptedCreds: creds.sealCreds(credBundle),
    });
    return res.status(201).json({ ok: true, target: publicTarget(created) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create target' });
  }
});

router.put('/targets/:id', authenticateToken, async (req, res) => {
  try {
    const existing = await targets.findByIdForUser(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Target not found', code: 'not_found' });
    const data = normalizeTargetBody({ ...existing, ...req.body });
    const patch = { ...data };
    // Only re-seal creds when a new secret is supplied.
    if ((req.body && req.body.password) || (req.body && req.body.privateKey)) {
      patch.encryptedCreds = creds.sealCreds({
        password: req.body.password,
        privateKey: req.body.privateKey,
        passphrase: req.body.passphrase,
      });
    }
    await targets.update(req.params.id, req.user.id, patch);
    const updated = await targets.findByIdForUser(req.params.id, req.user.id);
    return res.json({ ok: true, target: publicTarget(updated) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update target' });
  }
});

router.delete('/targets/:id', authenticateToken, async (req, res) => {
  try {
    const result = await targets.deleteForUser(req.params.id, req.user.id);
    if (result.count === 0) return res.status(404).json({ error: 'Target not found', code: 'not_found' });
    return res.json({ ok: true, removed: result.count });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete target' });
  }
});

router.post('/targets/:id/test', authenticateToken, async (req, res) => {
  try {
    const target = await targets.findByIdForUser(req.params.id, req.user.id);
    if (!target) return res.status(404).json({ error: 'Target not found', code: 'not_found' });
    const bundle = creds.openCreds(target.encryptedCreds) || {};
    await assertSafeRemoteHost(target.host); // SSRF guard before connecting
    const transport = deployService.transportFor(target.protocol);
    await transport.testConnection({ ...target, ...bundle });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: `Connection test failed: ${err.message}`, code: 'connect_failed' });
  }
});

// ── Build plan ────────────────────────────────────────────────────

router.get('/connected/:id/build-plan', authenticateToken, async (req, res) => {
  try {
    const { localPath } = await loadClonedWorkspace(req);
    return res.json({ plan: buildService.detectBuildPlan(localPath) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'plan_failed' });
  }
});

// ── Deploy ────────────────────────────────────────────────────────

router.post('/connected/:id/deploy', authenticateToken, async (req, res) => {
  try {
    if (deployService.isDisabled()) {
      return res.status(503).json({ error: 'Deployments are disabled on this server', code: 'deploy_disabled' });
    }
    const { connection, localPath } = await loadClonedWorkspace(req);
    if (deployService.isRunningForConnection(connection.id)) {
      return res.status(409).json({ error: 'Ya hay un despliegue en curso para este proyecto', code: 'deploy_in_progress' });
    }
    const body = req.body || {};
    const { targetId, branch, buildCommand, outputDir, cleanSlate, mode, appName, remoteCommand, domain: dom, domainKind } = body;
    const configureNginx = Boolean(body.configureNginx);
    const target = await targets.findByIdForUser(targetId, req.user.id);
    if (!target) return res.status(404).json({ error: 'Hosting target not found', code: 'target_not_found' });
    const bundle = creds.openCreds(target.encryptedCreds);
    if (!bundle) return res.status(400).json({ error: 'Target credentials are unreadable — reconnect', code: 'bad_creds' });

    const domHost = dom ? domain.normalizeDomain(dom).host : '';
    // Remote path: explicit > VPS web root (when configuring nginx) > derived
    // from domain (shared addon) > target default.
    const remotePath =
      body.remotePath ||
      (configureNginx && domHost ? `/var/www/${domHost}` : null) ||
      (dom ? domain.remotePathForDomain(dom, { kind: domainKind || 'main', baseDir: target.remoteBaseDir }) : null) ||
      target.remoteBaseDir;

    // Merge stored build secrets (env) for this project.
    const envRow = await deployEnvs.findForConnection(connection.id, req.user.id);
    const buildEnv = envRow ? creds.openJson(envRow.encryptedEnv) : {};

    const deployment = await deployments.create({
      userId: req.user.id,
      connectedRepositoryId: connection.id,
      hostingTargetId: target.id,
      branch: branch || null,
      buildCommand: buildCommand !== undefined ? buildCommand : null,
      outputDir: outputDir || null,
      remotePath,
      status: 'queued',
      startedAt: new Date(),
    });

    deployService.start(deployment.id, {
      localPath,
      connectionId: connection.id,
      target: { ...target, ...bundle, siteUrl: (dom ? `https://${String(dom).replace(/^https?:\/\//, '')}` : target.siteUrl) },
      config: {
        buildCommand,
        outputDir,
        remotePath,
        cleanSlate,
        env: buildEnv,
        mode: mode === 'node' ? 'node' : 'static',
        appName,
        remoteCommand,
        domain: domHost || null,
        configureNginx,
        rootDir: body.rootDir,
        appPort: body.appPort,
        ssl: Boolean(body.ssl),
        sslEmail: body.sslEmail,
      },
      onEvent: (e) => {
        if (e.type !== 'status') return;
        const patch = { status: e.status };
        if (e.url) patch.url = e.url;
        if (e.error) patch.error = String(e.error).slice(0, 500);
        if (e.tail) patch.logTail = String(e.tail).slice(0, 8000);
        if (e.status === 'success' || e.status === 'error') patch.finishedAt = new Date();
        deployments.update(deployment.id, patch).catch(() => {});
      },
    });

    return res.status(201).json({ ok: true, deploymentId: deployment.id });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code || 'deploy_failed' });
  }
});

// POST /api/hosting/verify { url } → is the deployed site reachable?
router.post('/verify', authenticateToken, async (req, res) => {
  const result = await domain.verifyUrl(req.body && req.body.url);
  return res.json(result);
});

// POST /api/hosting/dns { targetId, domain } → DNS setup instructions
router.post('/dns', authenticateToken, async (req, res) => {
  try {
    const target = await targets.findByIdForUser(req.body && req.body.targetId, req.user.id);
    if (!target) return res.status(404).json({ error: 'Target not found', code: 'not_found' });
    return res.json({ dns: domain.dnsInstructions(target, req.body && req.body.domain) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to build DNS instructions' });
  }
});

// GET /api/hosting/connected/:id/env → stored secret KEYS (never values)
router.get('/connected/:id/env', authenticateToken, async (req, res) => {
  try {
    const connection = await connectedRepos.findByIdForUser(req.params.id, req.user.id);
    if (!connection) return res.status(404).json({ error: 'Connected repository not found', code: 'not_found' });
    const row = await deployEnvs.findForConnection(connection.id, req.user.id);
    const env = row ? creds.openJson(row.encryptedEnv) : {};
    return res.json({ keys: Object.keys(env) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read env' });
  }
});

// GET /api/hosting/connected/:id/env/values → full secret map for editing.
// Owner-scoped: only the connection's owner can read THEIR OWN secret values
// (same model as Replit/Vercel "reveal"). Used by the secrets editor UI so
// add/edit/delete never clobbers the other secrets.
router.get('/connected/:id/env/values', authenticateToken, async (req, res) => {
  try {
    const connection = await connectedRepos.findByIdForUser(req.params.id, req.user.id);
    if (!connection) return res.status(404).json({ error: 'Connected repository not found', code: 'not_found' });
    const row = await deployEnvs.findForConnection(connection.id, req.user.id);
    const env = row ? creds.openJson(row.encryptedEnv) : {};
    res.set('Cache-Control', 'no-store');
    return res.json({ env });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read env values' });
  }
});

// PUT /api/hosting/connected/:id/env { env: { KEY: value } } → replace all secrets
router.put('/connected/:id/env', authenticateToken, async (req, res) => {
  try {
    const connection = await connectedRepos.findByIdForUser(req.params.id, req.user.id);
    if (!connection) return res.status(404).json({ error: 'Connected repository not found', code: 'not_found' });
    const env = req.body && req.body.env && typeof req.body.env === 'object' ? req.body.env : {};
    const clean = {};
    for (const [k, v] of Object.entries(env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) clean[k] = String(v);
    }
    await deployEnvs.upsert(req.user.id, connection.id, creds.sealJson(clean));
    return res.json({ ok: true, keys: Object.keys(clean) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save env' });
  }
});

// POST /api/hosting/deployments/:deploymentId/cancel
router.post('/deployments/:deploymentId/cancel', authenticateToken, async (req, res) => {
  try {
    const row = await deployments.findByIdForUser(req.params.deploymentId, req.user.id);
    if (!row) return res.status(404).json({ error: 'Deployment not found', code: 'not_found' });
    const result = deployService.cancel(req.params.deploymentId);
    if (result.cancelled) await deployments.update(row.id, { status: 'error', error: 'Cancelado', finishedAt: new Date() }).catch(() => {});
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to cancel' });
  }
});

router.get('/connected/:id/deployments', authenticateToken, async (req, res) => {
  try {
    const connection = await connectedRepos.findByIdForUser(req.params.id, req.user.id);
    if (!connection) return res.status(404).json({ error: 'Connected repository not found', code: 'not_found' });
    const list = await deployments.listForConnection(connection.id, req.user.id, Number(req.query.limit) || 20);
    return res.json({ deployments: list });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list deployments' });
  }
});

router.get('/deployments/:deploymentId', authenticateToken, async (req, res) => {
  try {
    const row = await deployments.findByIdForUser(req.params.deploymentId, req.user.id);
    if (!row) return res.status(404).json({ error: 'Deployment not found', code: 'not_found' });
    // Merge live job state (if still running) over the persisted row.
    const live = deployService.status(req.params.deploymentId);
    return res.json({ deployment: row, live: live.status === 'unknown' ? null : live });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read deployment' });
  }
});

// SSE live logs
router.get('/deployments/:deploymentId/logs', authenticateToken, async (req, res) => {
  const row = await deployments.findByIdForUser(req.params.deploymentId, req.user.id);
  if (!row) return res.status(404).json({ error: 'Deployment not found', code: 'not_found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* socket closed */
    }
  };
  const unsubscribe = deployService.subscribe(req.params.deploymentId, send);
  // If the job already finished (no live job), replay persisted tail + close.
  if (deployService.status(req.params.deploymentId).status === 'unknown') {
    if (row.logTail) String(row.logTail).split('\n').forEach((line) => send({ type: 'log', line }));
    send({ type: 'status', status: row.status, url: row.url, error: row.error });
    return res.end();
  }
  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

module.exports = router;
