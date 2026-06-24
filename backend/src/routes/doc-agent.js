'use strict';

/**
 * /api/doc-agent — Cowork-style document agent over the user's uploads.
 *
 *   POST /run   (auth, SSE)
 *     body: { prompt: string, fileIds: string[], model?: string }
 *     Streams events while the agent works inside its sandbox:
 *       data: {"type":"sandbox_ready"|"iteration_start"|"tool_call"|
 *              "tool_result"|"outputs"|"artifact"|"final"|"error", ...}
 *     Each produced file in /workspace/outputs is persisted to the user's
 *     uploads storage and announced as an `artifact` event with a download
 *     URL (`/uploads/<userId>/<filename>`), same convention the chat's file
 *     cards already consume.
 *
 *   GET /health — driver availability (docker vs local fallback), no auth.
 */

const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { PrismaClient } = require('@prisma/client');
const { runDocumentAgent, DEFAULT_MODEL } = require('../services/doc-agent');

const prisma = new PrismaClient();
const router = express.Router();

const MIME_BY_EXT = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
};

router.get('/health', async (_req, res) => {
  const remoteConfigured = Boolean(process.env.SANDBOX_SERVICE_URL && process.env.SANDBOX_API_KEY);
  res.json({
    ok: true,
    defaultModel: DEFAULT_MODEL,
    drivers: [...(remoteConfigured ? ['remote'] : []), 'docker', 'local'],
  });
});

router.post(
  '/run',
  authenticateToken,
  body('prompt').isString().trim().isLength({ min: 1, max: 8000 }),
  body('fileIds').isArray({ min: 0, max: 10 }),
  body('model').optional().isString().trim().isLength({ max: 200 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'invalid_input', details: errors.array() });

    const userId = req.user.id;
    const { prompt, fileIds = [], model } = req.body;

    // Load the user's OWN files only (ownership enforced in the query).
    const rows = fileIds.length
      ? await prisma.file.findMany({ where: { id: { in: fileIds.map(String) }, userId } })
      : [];
    if (fileIds.length && rows.length !== fileIds.length) {
      return res.status(404).json({ error: 'file_not_found', found: rows.map((r) => r.id) });
    }
    const files = [];
    for (const row of rows) {
      try {
        files.push({ name: row.originalName || row.filename, buffer: await fs.readFile(row.path) });
      } catch {
        return res.status(410).json({ error: 'file_blob_missing', fileId: row.id });
      }
    }

    // SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (evt) => { try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch (_) { /* client gone */ } };
    const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 15_000);
    const abort = new AbortController();
    req.on('close', () => abort.abort());

    try {
      const result = await runDocumentAgent({
        files,
        instruction: prompt,
        model: model || undefined,
        onEvent: send,
        signal: abort.signal,
      });

      // Persist outputs into the user's uploads storage → download cards.
      const uploadsRoot = path.join(process.env.UPLOAD_DIR || 'uploads', userId);
      await fs.mkdir(uploadsRoot, { recursive: true });
      const artifacts = [];
      for (const out of result.outputs) {
        // Never deliver an empty file as a download card — it is always junk
        // (e.g. a failed repack); the invalid-output event already reported it.
        if (!out.buffer || out.buffer.length === 0) continue;
        const ext = String(out.name).split('.').pop().toLowerCase();
        const filename = `docagent-${Date.now()}-${out.name}`.replace(/[^\w.\-() À-ɏ]/g, '_');
        const abs = path.join(uploadsRoot, filename);
        await fs.writeFile(abs, out.buffer);
        const rec = await prisma.file.create({
          data: {
            userId,
            filename,
            originalName: out.name,
            mimeType: MIME_BY_EXT[ext] || 'application/octet-stream',
            size: out.buffer.length,
            path: abs,
            processingStage: 'ready',
          },
        });
        const artifact = {
          id: rec.id, name: out.name, size: out.buffer.length,
          url: `/uploads/${userId}/${filename}`,
          valid: out.valid !== false,
          ...(out.valid === false ? { warning: 'El archivo generado puede estar dañado (estructura OOXML inválida).' } : {}),
        };
        artifacts.push(artifact);
        send({ type: 'artifact', ...artifact });
      }

      send({ type: 'done', finalText: result.finalText, iterations: result.iterations, stoppedReason: result.stoppedReason, driver: result.driver, artifacts });
    } catch (err) {
      send({ type: 'error', message: err?.message || 'doc agent failed' });
    } finally {
      clearInterval(heartbeat);
      try { res.end(); } catch (_) { /* already closed */ }
    }
  },
);

module.exports = router;
