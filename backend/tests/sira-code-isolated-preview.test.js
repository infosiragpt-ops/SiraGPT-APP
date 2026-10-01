'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const siraCode = require('../src/services/sira-code');
const {
  startIsolatedPreview,
  proveWorkspace,
  stopAllForTests,
} = require('../src/services/sira-code/isolated-preview');
const { getSession } = require('../src/services/sira-code/session-store');

afterEach(() => {
  stopAllForTests();
  siraCode._resetForTests();
});

function getOnce(url, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = extra.path
      ? http.get({ host: extra.host || '127.0.0.1', port: extra.port, path: extra.path, timeout: 3000 }, onRes)
      : http.get(url, { timeout: 3000 }, onRes);
    function onRes(res) {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

test('isolated preview serves index.html on 127.0.0.1 and blocks path escape', async () => {
  const created = await siraCode.create({ userId: 'u-preview' });
  const session = getSession(created.id);
  const html = '<!doctype html><h1>hola</h1>';
  await fs.writeFile(path.join(session.workspace.root, 'index.html'), html);
  const handle = await startIsolatedPreview(session.workspace);
  try {
    assert.equal(handle.host, '127.0.0.1');
    const addr = handle.server.address();
    assert.equal(addr.address, '127.0.0.1');
    const ok = await getOnce(handle.url);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, html);
    const evil = await getOnce(null, { port: handle.port, path: '/../../etc/passwd' });
    assert.ok(evil.status === 403 || evil.status === 404);
    assert.ok(!evil.body.includes('root:'));
  } finally {
    await handle.stop();
  }
});

test('proveWorkspace requires run + preview + html tests for 100', async () => {
  const created = await siraCode.create({ userId: 'u-proof' });
  const session = getSession(created.id);
  const missing = await proveWorkspace(session.workspace);
  assert.equal(missing.executed, false);
  assert.equal(missing.previewOk, false);
  assert.equal(missing.testsOk, false);

  await fs.writeFile(path.join(session.workspace.root, 'index.html'), '<!doctype html><h1>web</h1>');
  const proof = await proveWorkspace(session.workspace);
  assert.equal(proof.executed, true);
  assert.equal(proof.previewOk, true);
  assert.equal(proof.testsOk, true);
  assert.match(proof.previewUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test('done reports 100 only after isolated run and preview of index.html', async () => {
  siraCode._resetForTests();
  const session = await siraCode.create({ userId: 'u-progress-100' });
  let calls = 0;
  await siraCode.prompt(session.id, 'crea una pagina', {
    userId: 'u-progress-100',
    llmTurn: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: '',
          toolCalls: [{
            name: 'write',
            arguments: { path: 'index.html', content: '<!doctype html><h1>listo</h1>' },
          }],
        };
      }
      return { text: 'Hecho.', toolCalls: [] };
    },
  });
  const live = getSession(session.id);
  const done = live.events.filter((ev) => ev.step === 'done').at(-1);
  assert.equal(done.progress, 100);
  assert.equal(done.proof.executed, true);
  assert.equal(done.proof.previewOk, true);
  assert.equal(done.proof.testsOk, true);
  assert.match(done.proof.previewUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});
