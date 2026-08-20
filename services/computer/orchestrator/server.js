'use strict';

/**
 * SiraGPT agent-computer orchestrator.
 *
 * One Docker container per session (siragpt-computer image). TTL 30 minutes,
 * renewable. Never lists, stops, or recreates sira-dpc-* CEO Office webtops.
 *
 *   GET    /health
 *   POST   /sessions
 *   GET    /sessions/:id
 *   POST   /sessions/:id/renew
 *   DELETE /sessions/:id
 *
 * Auth: Bearer COMPUTER_ORCH_SECRET (except /health).
 */

const express = require('express');
const { loadConfig } = require('./config');
const { requireOrchSecret } = require('./auth');
const { SessionManager } = require('./sessions');

function defaultDocker() {
  const Docker = require('dockerode');
  return new Docker({ socketPath: '/var/run/docker.sock' });
}

function createApp({ env = process.env, docker, manager } = {}) {
  const cfg = loadConfig(env);
  const sessions = manager || new SessionManager({
    docker: docker || defaultDocker(),
    env,
  });
  sessions.startReaper();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(requireOrchSecret(cfg.secret));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'siragpt-computer-orchestrator',
      sessions: sessions.sessions.size,
      image: cfg.image,
      ttlMs: cfg.ttlMs,
      note: 'TTL applies only to sira-acomp-* agent-computer sessions, never sira-dpc-* webtops.',
    });
  });

  app.post('/sessions', async (_req, res) => {
    try {
      const created = await sessions.create();
      return res.status(201).json(created);
    } catch (err) {
      const status = err.status || 500;
      return res.status(status).json({ error: err.code || 'create_failed', message: err.message });
    }
  });

  app.get('/sessions/:id', (req, res) => {
    const entry = sessions.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'not_found' });
    sessions.touch(entry);
    return res.json(sessions.toPublic(entry));
  });

  app.post('/sessions/:id/renew', (req, res) => {
    const renewed = sessions.renew(req.params.id);
    if (!renewed) return res.status(404).json({ error: 'not_found' });
    return res.json(renewed);
  });

  app.delete('/sessions/:id', async (req, res) => {
    try {
      const result = await sessions.destroy(req.params.id);
      if (!result.destroyed) return res.status(404).json({ error: 'not_found' });
      return res.json(result);
    } catch (err) {
      return res.status(err.status || 500).json({ error: 'destroy_failed', message: err.message });
    }
  });

  return { app, sessions, cfg };
}

function start({ env = process.env } = {}) {
  const cfg = loadConfig(env);
  if (!cfg.secret) {
    // eslint-disable-next-line no-console
    console.error('FATAL: COMPUTER_ORCH_SECRET is not set. Refusing to start an unauthenticated orchestrator.');
    process.exit(1);
  }
  const { app } = createApp({ env });
  return app.listen(cfg.port, cfg.bind, () => {
    // eslint-disable-next-line no-console
    console.log(`[computer-orch] listening on ${cfg.bind}:${cfg.port} image=${cfg.image} ttlMs=${cfg.ttlMs}`);
  });
}

if (require.main === module) start();

module.exports = { createApp, start };
