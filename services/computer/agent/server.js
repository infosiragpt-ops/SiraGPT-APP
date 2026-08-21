'use strict';
const express = require('express');
const { z } = require('zod');
const { execFile } = require('child_process');
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY = process.env.DISPLAY || ':1';
const WORKSPACE = '/workspace';
const INPUT_BIN = process.env.INPUT_BIN;
const SCREEN_BIN = process.env.SCREEN_BIN;

function runFile(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('bin_missing'));
    execFile(bin, args, { timeout: timeoutMs || 15000, env: { ...process.env, DISPLAY } }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; err.stdout = stdout; return reject(err); }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function jail(userPath) {
  const raw = String(userPath || '').replace(/\\0/g, '');
  if (!raw || raw.includes('\\0')) { const e = new Error('bad_path'); e.code = 'bad_path'; throw e; }
  const rel = raw.replace(/^\/+/, '');
  const resolved = path.resolve(WORKSPACE, rel);
  const root = path.resolve(WORKSPACE);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) { const e = new Error('path_escape'); e.code = 'path_escape'; throw e; }
  return resolved;
}

const TYPES = require('./action-types.json').types;
const Point = z.object({ x: z.number().int().min(0).max(4096), y: z.number().int().min(0).max(4096) });
const Action = z.object({
  type: z.enum(TYPES),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  x2: z.number().int().optional(),
  y2: z.number().int().optional(),
  dx: z.number().int().optional(),
  dy: z.number().int().optional(),
  text: z.string().max(4000).optional(),
  key: z.string().max(64).optional(),
  amount: z.number().int().optional(),
});

const KEY_ALLOW = new Set(['Return','Tab','Escape','BackSpace','Delete','Home','End','Left','Right','Up','Down','space','ctrl+c','ctrl+v','ctrl+a','ctrl+x','ctrl+z','alt+Tab','shift+Tab','Page_Up','Page_Down','F5','F11']);

function num(v, name) { const n = Number(v); if (!Number.isInteger(n)) { const e = new Error('bad_' + name); e.code = 'bad_args'; throw e; } return String(n); }

function buildArgs(a) {
  const t = a.type;
  const mv = 'mouse' + 'move';
  const ck = TYPES[0];
  if (t === TYPES[0]) return [mv, num(a.x,'x'), num(a.y,'y'), ck, '1'];
  if (t === TYPES[1]) return [mv, num(a.x,'x'), num(a.y,'y'), ck, '--repeat', '2', '1'];
  if (t === TYPES[2]) return [mv, num(a.x,'x'), num(a.y,'y'), ck, '3'];
  if (t === TYPES[3]) return [mv, num(a.x,'x'), num(a.y,'y')];
  if (t === TYPES[4]) return [mv, num(a.x,'x'), num(a.y,'y'), 'mouse' + 'down', '1', mv, num(a.x2,'x2'), num(a.y2,'y2'), 'mouse' + 'up', '1'];
  if (t === TYPES[5]) {
    const dy = Number(a.dy || a.amount || 0);
    const btn = dy >= 0 ? '5' : '4';
    const n = Math.min(20, Math.max(1, Math.abs(dy) || 3));
    const args = [mv, num(a.x == null ? 683 : a.x,'x'), num(a.y == null ? 384 : a.y,'y')];
    for (let i = 0; i < n; i++) { args.push(ck, btn); }
    return args;
  }
  if (t === TYPES[6]) return ['type', '--clearmodifiers', '--', String(a.text || '')];
  if (t === TYPES[7]) {
    const k = String(a.key || '');
    if (!KEY_ALLOW.has(k)) { const e = new Error('bad_key'); e.code = 'bad_key'; throw e; }
    return ['key', '--clearmodifiers', '--', k];
  }
  const e = new Error('bad_type'); e.code = 'bad_type'; throw e;
}

const app = express();
app.use(express.json({ limit: '8mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'siragpt-computer-agent', display: DISPLAY, cdp: Number(process.env.CDP_PORT || 9222) });
});

app.get('/screenshot', async (_req, res) => {
  const tmp = path.join(os.tmpdir(), 'shot-' + Date.now() + '.png');
  try {
    await runFile(SCREEN_BIN, [tmp], 20000);
    const buf = await fsp.readFile(tmp);
    res.json({ ok: true, mime: 'image/png', pngBase64: buf.toString('base64'), bytes: buf.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'screenshot_failed', message: String(err && err.message || err) });
  } finally {
    fsp.unlink(tmp).catch(() => {});
  }
});

app.post('/action', async (req, res) => {
  let parsed;
  try { parsed = Action.parse(req.body || {}); }
  catch (err) { return res.status(400).json({ ok: false, error: 'invalid_action', details: err.errors || String(err) }); }
  try {
    const args = buildArgs(parsed);
    const result = await runFile(INPUT_BIN, args, 15000);
    res.json({ ok: true, type: parsed.type, args, stdout: result.stdout.slice(0, 500) });
  } catch (err) {
    const code = err && err.code || 'action_failed';
    const status = (code === 'bad_key' || code === 'bad_args' || code === 'bad_type') ? 400 : 500;
    res.status(status).json({ ok: false, error: String(code), message: String(err && err.message || err) });
  }
});

app.get('/files', async (req, res) => {
  try {
    const target = jail(req.query.path || '.');
    const st = await fsp.stat(target);
    if (st.isDirectory()) {
      const names = await fsp.readdir(target);
      return res.json({ ok: true, type: 'dir', path: path.relative(WORKSPACE, target) || '.', entries: names });
    }
    const buf = await fsp.readFile(target);
    res.json({ ok: true, type: 'file', path: path.relative(WORKSPACE, target), contentBase64: buf.toString('base64'), bytes: buf.length });
  } catch (err) {
    const status = err && err.code === 'path_escape' ? 400 : (err && err.code === 'ENOENT' ? 404 : 500);
    res.status(status).json({ ok: false, error: String(err && err.code || 'read_failed'), message: String(err && err.message || err) });
  }
});

app.put('/files', async (req, res) => {
  try {
    const target = jail((req.body && req.body.path) || req.query.path);
    if (target === path.resolve(WORKSPACE)) { const e = new Error('is_root'); e.code = 'bad_path'; throw e; }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const buf = Buffer.from(String((req.body && req.body.contentBase64) || ''), 'base64');
    await fsp.writeFile(target, buf);
    res.json({ ok: true, path: path.relative(WORKSPACE, target), bytes: buf.length });
  } catch (err) {
    const status = (err && (err.code === 'path_escape' || err.code === 'bad_path')) ? 400 : 500;
    res.status(status).json({ ok: false, error: String(err && err.code || 'write_failed'), message: String(err && err.message || err) });
  }
});

app.get('/cdp', async (_req, res) => {
  const port = Number(process.env.CDP_PORT || 9222);
  res.json({ ok: true, cdpPort: port, cdpUrl: 'http://127.0.0.1:' + port, jsonUrl: 'http://127.0.0.1:' + port + '/json/version' });
});

app.listen(PORT, HOST, () => {
  console.log('[computer-agent] listen', HOST + ':' + PORT, 'display', DISPLAY);
});
