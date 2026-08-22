'use strict';

/**
 * FEATURE_DOC_ENGINE routes (default off → not registered → Express 404).
 *   GET  /api/documents/healthz
 *   POST /api/documents/transform
 *   GET  /api/documents/:jobId/stream   (Last-Event-ID replay)
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
const streamResume = require('../services/ai/stream-resume');
const artifacts = require('../services/doc-engine/artifact-store');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 4 },
});

function signer() {
  const cfg = getDocEngineConfig();
  const secret = cfg.signingSecret || 'doc-engine-dev-signing-secret';
  return createSignedUrlSigner({ secret, defaultTtlSec: cfg.artifactTtlSec });
}

async function writeSseEvent(sse, ev) {
  const id = Number.isFinite(ev?.id) ? ev.id : (ev?.seq ?? 0);
  const frame = `id: ${id}\ndata: ${JSON.stringify(ev)}\n\n`;
  return sse.raw(frame);
}

function replayFrom(events, lastEventIdHeader) {
  const list = Array.isArray(events) ? events : [];
  const parsed = streamResume.parseLastEventId(lastEventIdHeader);
  if (!parsed) return list;
  const pos = Number(parsed.position) || 0;
  return list.filter((ev) => {
    const id = Number.isFinite(ev?.id) ? ev.id : -1;
    return id > pos;
  });
}

router.get('/healthz', (req, res) => {
  return res.status(200).json({
    ok: true,
    feature: 'FEATURE_DOC_ENGINE',
    enabled: true,
    engine: 'doc-engine',
    image: getDocEngineConfig().image,
    transform: '/api/documents/transform',
  });
});

router.post(
  '/transform',
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
      try { await streamResume.open({ streamId: job.id }); } catch { /* best-effort */ }
      return res.status(202).json({ jobId: job.id, status: job.status });
    } catch (err) {
      return res.status(500).json({ error: 'enqueue_failed', message: String(err?.message || err).slice(0, 300) });
    }
  },
);

router.get('/:jobId/stream', authenticateToken, async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  if (job.userId && req.user?.id && job.userId !== req.user.id) {
    return res.status(404).json({ error: 'job_not_found' });
  }
  const lastEventId = req.get && req.get('Last-Event-ID');
  let events = job.events;
  if (lastEventId) {
    try {
      const existing = await streamResume.openExisting({ streamId: job.id });
      if (existing.found && existing.record?.chunks?.length) {
        events = existing.record.chunks.map((chunk, i) => {
          try { return JSON.parse(chunk); } catch { return { id: i, type: 'chunk', data: chunk }; }
        });
      }
    } catch { /* memory events */ }
  }
  const sse = createSSEWriter(res);
  for (const ev of replayFrom(events, lastEventId)) {
    await writeSseEvent(sse, ev);
  }
  if (job.status === 'done' || job.status === 'error') {
    await sse.done();
    return;
  }
  const off = subscribe(job.id, async (ev) => {
    await writeSseEvent(sse, ev);
    if (ev.type === 'done' || ev.type === 'error') {
      off();
      try { await streamResume.complete(job.id); } catch { /* noop */ }
      await sse.done();
    }
  });
  req.on('close', () => off());
});

router.get('/:jobId/artifact', async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });

  const cfg = getDocEngineConfig();
  const s = signer();
  const pathUrl = `/api/documents/${job.id}/artifact`;
  const incoming = `${pathUrl}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;

  if (req.query.sig) {
    const verified = s.verify(incoming.startsWith('http') ? incoming : incoming);
    if (!verified.ok) return res.status(403).json({ error: 'invalid_signature', reason: verified.reason });
    const fromDisk = artifacts.readOutput(job.id, 'output.docx');
    const buffer = fromDisk || job.artifact?.buffer;
    if (!buffer) return res.status(409).json({ error: 'artifact_not_ready' });
    res.setHeader('Content-Type', job.artifact?.mime || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${job.artifact?.filename || 'documento-formato.docx'}"`);
    return res.send(buffer);
  }

  return authenticateToken(req, res, () => {
    if (job.userId && req.user?.id && job.userId !== req.user.id) {
      return res.status(404).json({ error: 'job_not_found' });
    }
    if (!job.artifact && !artifacts.readOutput(job.id, 'output.docx')) {
      return res.status(409).json({ error: 'artifact_not_ready', status: job.status });
    }
    const url = s.sign(pathUrl, { ttlSec: cfg.artifactTtlSec });
    return res.json({ url, expiresInSec: cfg.artifactTtlSec, filename: job.artifact?.filename || 'documento-formato.docx' });
  });
});

function registerDocumentsRoutes(app, { enabled = isDocEngineEnabled() } = {}) {
  if (!enabled) return false;
  app.use('/api/documents', router);
  return true;
}

module.exports = router;
module.exports.registerDocumentsRoutes = registerDocumentsRoutes;
module.exports.replayFrom = replayFrom;
module.exports.writeSseEvent = writeSseEvent;
