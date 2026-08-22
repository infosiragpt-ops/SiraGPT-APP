'use strict';

/**
 * In-image HTTP agent. Runs as compuser inside the desktop container.
 *
 * GET  /health
 * GET  /screenshot          → { png }  (Accept: image/png returns raw bytes)
 * POST /action              → zod-validated xdotool (execFile argv only)
 * GET  /files?path=         → list/read under /workspace
 * PUT  /files               → write under /workspace
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const { ZodError } = require('zod');

const { parseAction } = require('./schemas');
const { executeAction } = require('./actions');
const { listOrRead, writeFileSafe, ensureTaskDir, FilePathError } = require('./files');

const pexecFile = promisify(execFile);

const PORT = Number(process.env.COMPUTER_AGENT_PORT || 8080);
const BIND = process.env.COMPUTER_AGENT_BIND || '0.0.0.0';
const DISPLAY = process.env.DISPLAY || ':1';
const SCROT = process.env.COMPUTER_SCROT || 'scrot';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'siragpt-computer-agent',
    display: DISPLAY,
    user: os.userInfo().username,
    workspace: process.env.COMPUTER_WORKSPACE_ROOT || '/workspace',
  });
});

async function capturePng() {
  const tmp = path.join(os.tmpdir(), `sira-shot-${process.pid}-${Date.now()}.png`);
  try {
    await pexecFile(SCROT, ['-o', tmp], {
      timeout: 15_000,
      env: { ...process.env, DISPLAY },
      maxBuffer: 1024 * 1024,
    });
    return fs.readFileSync(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

app.get('/screenshot', async (req, res) => {
  try {
    const buf = await capturePng();
    const wantsPng = String(req.headers.accept || '').includes('image/png')
      || String(req.query.format || '') === 'png';
    if (wantsPng) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', buf.length);
      return res.end(buf);
    }
    return res.json({ png: buf.toString('base64'), mediaType: 'image/png' });
  } catch (err) {
    return res.status(500).json({ error: 'screenshot_failed', message: err.message });
  }
});

app.post('/action', async (req, res) => {
  try {
    const action = parseAction(req.body || {});
    const result = await executeAction(action);
    return res.json(result);
  } catch (err) {
    if (err instanceof ZodError || err.name === 'ZodError') {
      return res.status(400).json({ error: 'invalid_action', details: err.flatten ? err.flatten() : err.message });
    }
    return res.status(500).json({ error: 'action_failed', message: err.message });
  }
});

app.get('/files', async (req, res) => {
  try {
    const result = await listOrRead(req.query.path || '.');
    return res.json(result);
  } catch (err) {
    const status = err instanceof FilePathError ? err.status : (err.code === 'ENOENT' ? 404 : 500);
    return res.status(status).json({ error: err.code || 'files_failed', message: err.message });
  }
});

app.post('/tasks', async (req, res) => {
  try {
    const result = await ensureTaskDir(req.body?.taskId);
    return res.status(201).json(result);
  } catch (err) {
    const status = err instanceof FilePathError ? err.status : 500;
    return res.status(status).json({ error: err.code || 'task_failed', message: err.message });
  }
});

app.put('/files', async (req, res) => {
  try {
    const body = req.body || {};
    const filePath = body.path;
    const encoding = body.contentBase64 != null ? 'base64' : 'utf8';
    const content = body.contentBase64 != null ? body.contentBase64 : body.content;
    if (content == null) return res.status(400).json({ error: 'content_required' });
    const result = await writeFileSafe(filePath, content, { encoding });
    return res.json(result);
  } catch (err) {
    const status = err instanceof FilePathError ? err.status : 500;
    return res.status(status).json({ error: err.code || 'write_failed', message: err.message });
  }
});

function start(port = PORT, bind = BIND) {
  return app.listen(port, bind, () => {
    // eslint-disable-next-line no-console
    console.log(`[computer-agent] listening on ${bind}:${port} DISPLAY=${DISPLAY}`);
  });
}

if (require.main === module) start();

module.exports = { app, start, capturePng };
