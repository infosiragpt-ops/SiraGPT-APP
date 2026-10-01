'use strict';

/**
 * Isolated run + preview for SiraCode webdev workspaces.
 *
 * Binds 127.0.0.1 only, serves files through jailRealPath, never the
 * host tree. 100% progress still requires executed + previewOk + testsOk.
 * No new UI and no AGENTES_CODING_V2.
 */

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { jailRealPath, MAX_FILE_BYTES } = require('./workspace');

const HOST = '127.0.0.1';
const FETCH_TIMEOUT_MS = 3_000;
const live = new Set();

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
});

function emptyProof() {
  return {
    executed: false,
    previewOk: false,
    testsOk: false,
    previewUrl: '',
  };
}

function publicProof(proof = {}) {
  return {
    executed: proof.executed === true,
    previewOk: proof.previewOk === true,
    testsOk: proof.testsOk === true,
    previewUrl: typeof proof.previewUrl === 'string' ? proof.previewUrl : '',
  };
}

async function hasIndexHtml(root) {
  try {
    const abs = await jailRealPath(root, 'index.html');
    const st = await fs.stat(abs);
    return st.isFile() && st.size > 0 && st.size <= MAX_FILE_BYTES ? abs : null;
  } catch {
    return null;
  }
}

function requestRelPath(req) {
  const raw = String(req.url || '/').split('?')[0];
  let pathname = '/';
  try {
    pathname = new URL(raw, 'http://127.0.0.1/').pathname;
  } catch {
    pathname = raw || '/';
  }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') return 'index.html';
  return rel.replace(/^\/+/, '');
}

async function serveWorkspace(root, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const rel = requestRelPath(req);
  let abs;
  try {
    abs = await jailRealPath(root, rel);
  } catch (err) {
    const code = err && err.code === 'path_traversal' ? 403 : 404;
    res.writeHead(code).end();
    return;
  }
  let st;
  try {
    st = await fs.lstat(abs);
  } catch {
    res.writeHead(404).end();
    return;
  }
  if (st.isSymbolicLink()) {
    res.writeHead(403).end();
    return;
  }
  if (st.isDirectory()) {
    try {
      abs = await jailRealPath(root, path.posix.join(rel === 'index.html' ? '' : rel, 'index.html'));
      st = await fs.lstat(abs);
    } catch {
      res.writeHead(404).end();
      return;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      res.writeHead(403).end();
      return;
    }
  }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) {
    res.writeHead(404).end();
    return;
  }
  const buf = await fs.readFile(abs);
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(buf);
}

async function startIsolatedPreview(workspace, { signal } = {}) {
  const root = workspace && workspace.root;
  if (!root) {
    const err = new Error('workspace ausente');
    err.code = 'missing_workspace';
    throw err;
  }
  const server = http.createServer((req, res) => {
    serveWorkspace(root, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(0, HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const addr = server.address();
  const port = addr && addr.port;
  const url = `http://${HOST}:${port}/`;
  const handle = {
    url,
    port,
    host: HOST,
    server,
    async stop() {
      live.delete(handle);
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      });
    },
  };
  live.add(handle);
  if (signal) {
    const onAbort = () => {
      handle.stop().catch(() => {});
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return handle;
}

function fetchLocal(url, { path: reqPath, port } = {}) {
  return new Promise((resolve, reject) => {
    const onRes = (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks),
        });
      });
    };
    const req = reqPath
      ? http.get({ host: HOST, port, path: reqPath, timeout: FETCH_TIMEOUT_MS }, onRes)
      : http.get(url, { timeout: FETCH_TIMEOUT_MS }, onRes);
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

async function proveWorkspace(workspace, { signal, keepAlive = false } = {}) {
  const proof = emptyProof();
  const root = workspace && workspace.root;
  if (!root) return proof;
  const indexAbs = await hasIndexHtml(root);
  if (!indexAbs) return proof;

  const handle = await startIsolatedPreview(workspace, { signal });
  proof.executed = true;
  proof.previewUrl = handle.url;
  try {
    const disk = await fs.readFile(indexAbs);
    const res = await fetchLocal(handle.url);
    proof.previewOk = res.status === 200 && res.body.equals(disk);
    let escapeStatus = 0;
    try {
      const evil = await fetchLocal(null, { port: handle.port, path: '/../../etc/passwd' });
      escapeStatus = evil.status;
    } catch {
      escapeStatus = 0;
    }
    const traversalBlocked = escapeStatus === 403 || escapeStatus === 404;
    const looksLikeHtml = /<!doctype html|<html[\s>]|<h1[\s>]/i.test(disk.toString('utf8'));
    proof.testsOk = proof.previewOk && traversalBlocked && looksLikeHtml;
  } catch {
    proof.previewOk = false;
    proof.testsOk = false;
  }
  if (keepAlive) {
    proof.handle = handle;
  } else {
    await handle.stop().catch(() => {});
  }
  return proof;
}

async function attachProof(session, { signal } = {}) {
  if (session && session.proof && session.proof.previewOk && session.proof.testsOk) {
    return publicProof(session.proof);
  }
  const proof = await proveWorkspace(session && session.workspace, {
    signal: signal || (session && session.abort && session.abort.signal),
    keepAlive: true,
  });
  if (session && session.isolatedPreview && typeof session.isolatedPreview.stop === 'function') {
    await session.isolatedPreview.stop().catch(() => {});
  }
  if (session) {
    session.isolatedPreview = proof.handle || null;
    session.proof = publicProof(proof);
  }
  return publicProof(proof);
}

async function stopPreview(session) {
  const handle = session && session.isolatedPreview;
  if (handle && typeof handle.stop === 'function') {
    await handle.stop().catch(() => {});
  }
  if (session) session.isolatedPreview = null;
}

function stopAllForTests() {
  for (const handle of [...live]) {
    try {
      handle.server.close();
      if (typeof handle.server.closeAllConnections === 'function') {
        handle.server.closeAllConnections();
      }
    } catch { /* tests shutting down */ }
    live.delete(handle);
  }
}

module.exports = {
  HOST,
  emptyProof,
  publicProof,
  hasIndexHtml,
  startIsolatedPreview,
  proveWorkspace,
  attachProof,
  stopPreview,
  stopAllForTests,
};
