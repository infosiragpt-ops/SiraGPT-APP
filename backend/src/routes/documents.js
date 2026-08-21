'use strict';

/**
 * FEATURE_DOC_ENGINE routes (default off → 404).
 *   POST /api/documents/transform
 *   GET  /api/documents/:jobId/stream
 *   GET  /api/documents/:jobId/artifact
 *
 * No se tocan /chat ni /code.
 */

const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/auth');
const { createSSEWriter } = require('../utils/sse-writer');
const { createSignedUrlSigner } = require('../services/auth/signed-url');
const { isDocEngineEnabled, getDocEngineConfig } = require('../services/doc-engine/flags');
const { enqueueDocJob } = require('../services/doc-engine/queue');
const { getJob, subscribe } = require('../services/doc-engine/job-store');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 4 },
});

function flagGate(req, res, next) {
  if (!isDocEngineEnabled()) {
    return res.status(404).json({ error: 'not_found', feature: 'FEATURE_DOC_ENGINE' });
  }
  return next();
}

function signer() {
  const cfg = getDocEngineConfig();
  const secret = cfg.signingSecret || 'doc-engine-dev-signing-secret';
  return createSignedUrlSigner({ secret, defaultTtlSec: cfg.artifactTtlSec });
}

router.post(
  '/transform',
  flagGate,
  authenticateToken,
  upload.fields([
    { name: 'source', maxCount: 1 },
    { name: 'template', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const source = req.files?.source?.[0];
      const template = req.files?.template?.[0];
      if (!source?.buffer || !template?.buffer) {
        return res.status(400).json({ error: 'source_and_template_required' });
      }
      const instructions = String(req.body?.instructions || req.body?.prompt || '');
      const job = await enqueueDocJob({
        userId: req.user?.id,
        sourceBuffer: source.buffer,
        templateBuffer: template.buffer,
        instructions,
        sourceName: source.originalname,
        templateName: template.originalname,
      });
      return res.status(202).json({ jobId: job.id, status: job.status });
    } catch (err) {
      return res.status(500).json({ error: 'enqueue_failed', message: String(err?.message || err).slice(0, 300) });
    }
  },
);

router.get('/:jobId/stream', flagGate, authenticateToken, async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  if (job.userId && req.user?.id && job.userId !== req.user.id) {
    return res.status(404).json({ error: 'job_not_found' });
  }
  const sse = createSSEWriter(res);
  for (const ev of job.events) {
    await sse.event(ev);
  }
  if (job.status === 'done' || job.status === 'error') {
    await sse.done();
    return;
  }
  const off = subscribe(job.id, async (ev) => {
    await sse.event(ev);
    if (ev.type === 'done' || ev.type === 'error') {
      off();
      await sse.done();
    }
  });
  req.on('close', () => off());
});

router.get('/:jobId/artifact', flagGate, async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });

  const cfg = getDocEngineConfig();
  const s = signer();
  const pathUrl = `/api/documents/${job.id}/artifact`;
  const incoming = `${pathUrl}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;

  if (req.query.sig) {
    const verified = s.verify(incoming.startsWith('http') ? incoming : incoming);
    if (!verified.ok) return res.status(403).json({ error: 'invalid_signature', reason: verified.reason });
    if (!job.artifact?.buffer) return res.status(409).json({ error: 'artifact_not_ready' });
    res.setHeader('Content-Type', job.artifact.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${job.artifact.filename}"`);
    return res.send(job.artifact.buffer);
  }

  // Sin firma: exige auth y devuelve URL firmada 15 min.
  return authenticateToken(req, res, () => {
    if (job.userId && req.user?.id && job.userId !== req.user.id) {
      return res.status(404).json({ error: 'job_not_found' });
    }
    if (!job.artifact) return res.status(409).json({ error: 'artifact_not_ready', status: job.status });
    const url = s.sign(pathUrl, { ttlSec: cfg.artifactTtlSec });
    return res.json({ url, expiresInSec: cfg.artifactTtlSec, filename: job.artifact.filename });
  });
});

module.exports = router;
