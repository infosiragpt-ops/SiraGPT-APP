'use strict';

/**
 * FEATURE_DOC_ARTIFACT_EDITOR routes (default off → 404 salvo /health).
 *   GET  /api/doc-artifact-editor/health
 *   POST /api/doc-artifact-editor/sessions          open artifact
 *   GET  /api/doc-artifact-editor/sessions/:id
 *   POST /api/doc-artifact-editor/sessions/:id/edits
 *   GET  /api/doc-artifact-editor/sessions/:id/stream
 *   GET  /api/doc-artifact-editor/sessions/:id/download
 *
 * Aislado del chrome de /chat. DeepSeek only.
 */

const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/auth');
const { createSSEWriter } = require('../utils/sse-writer');
const { isDocArtifactEditorEnabled, getDocArtifactEditorConfig } = require('../services/doc-artifact-editor/flags');
const { openArtifact, applyEdit, downloadSession, listPublicSession } = require('../services/doc-artifact-editor/service');
const { getSession, subscribe } = require('../services/doc-artifact-editor/session-store');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

function flagGate(req, res, next) {
  if (!isDocArtifactEditorEnabled()) {
    return res.status(404).json({ error: 'not_found', feature: 'FEATURE_DOC_ARTIFACT_EDITOR' });
  }
  return next();
}

router.get('/health', (req, res) => {
  const enabled = isDocArtifactEditorEnabled();
  return res.status(200).json({
    ok: true,
    enabled,
    feature: 'FEATURE_DOC_ARTIFACT_EDITOR',
    provider: 'deepseek',
    forbiddenProviders: ['openrouter'],
    isolatedFromChatChrome: true,
  });
});

router.post('/sessions', flagGate, authenticateToken, upload.single('artifact'), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ error: 'artifact_required' });
    const session = openArtifact({
      userId: req.user?.id,
      artifactId: req.body?.artifactId || null,
      filename: file.originalname || 'documento.docx',
      buffer: file.buffer,
      instructions: req.body?.instructions || '',
    });
    return res.status(201).json(listPublicSession(session));
  } catch (err) {
    return res.status(400).json({ error: err.code || 'open_failed', message: String(err.message || err).slice(0, 300) });
  }
});

router.get('/sessions/:id', flagGate, authenticateToken, (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (session.userId && req.user?.id && session.userId !== req.user.id) {
    return res.status(404).json({ error: 'session_not_found' });
  }
  return res.json(listPublicSession(session));
});

router.post('/sessions/:id/edits', flagGate, authenticateToken, async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (session.userId && req.user?.id && session.userId !== req.user.id) {
    return res.status(404).json({ error: 'session_not_found' });
  }
  try {
    const out = await applyEdit(session.id, {
      instructions: req.body?.instructions || req.body?.prompt || '',
    });
    return res.json(out);
  } catch (err) {
    return res.status(400).json({ error: err.code || 'edit_failed', message: String(err.message || err).slice(0, 300) });
  }
});

router.get('/sessions/:id/stream', flagGate, authenticateToken, async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (session.userId && req.user?.id && session.userId !== req.user.id) {
    return res.status(404).json({ error: 'session_not_found' });
  }
  const sse = createSSEWriter(res);
  for (const ev of session.events) {
    await sse.event(ev);
  }
  if (session.status === 'done' || session.status === 'error') {
    await sse.done();
    return;
  }
  const off = subscribe(session.id, async (ev) => {
    await sse.event(ev);
    if (ev.type === 'done' || ev.type === 'error') {
      off();
      await sse.done();
    }
  });
  req.on('close', () => off());
});

router.get('/sessions/:id/download', flagGate, authenticateToken, (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  if (session.userId && req.user?.id && session.userId !== req.user.id) {
    return res.status(404).json({ error: 'session_not_found' });
  }
  const file = downloadSession(session.id);
  if (!file) return res.status(409).json({ error: 'artifact_not_ready' });
  const cfg = getDocArtifactEditorConfig();
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', `private, max-age=${cfg.artifactTtlSec}`);
  return res.send(file.buffer);
});

module.exports = router;
