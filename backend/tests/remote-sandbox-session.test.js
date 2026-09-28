'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteSandbox } = require('../src/services/doc-agent/remote-sandbox');

function response(body = {}, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('parallel first operations share one remote session and destroy it once', async () => {
  let created = 0;
  const deleted = [];
  const sandbox = createRemoteSandbox({
    baseUrl: 'https://sandbox.invalid', apiKey: 'test-key',
    fetchImpl: async (url, opts) => {
      if (opts.method === 'POST' && url.endsWith('/v1/sessions')) {
        created += 1;
        await new Promise((resolve) => setImmediate(resolve));
        return response({ sessionId: `session-${created}` }, 201);
      }
      if (opts.method === 'DELETE') deleted.push(url.split('/').pop());
      return response({ files: [] });
    },
  });
  await Promise.all([sandbox.listFiles(), sandbox.listFiles(), sandbox.listFiles()]);
  await sandbox.destroy();
  assert.equal(created, 1);
  assert.deepEqual(deleted, ['session-1']);
});

test('destroy waits for an in-flight create and deletes the eventual session', async () => {
  let creationStarted;
  const started = new Promise((resolve) => { creationStarted = resolve; });
  let finishCreation;
  const hold = new Promise((resolve) => { finishCreation = resolve; });
  const deleted = [];
  const sandbox = createRemoteSandbox({
    baseUrl: 'https://sandbox.invalid', apiKey: 'test-key',
    fetchImpl: async (url, opts) => {
      if (opts.method === 'POST' && url.endsWith('/v1/sessions')) {
        creationStarted();
        await hold;
        return response({ sessionId: 'session-late' }, 201);
      }
      if (opts.method === 'DELETE') deleted.push(url.split('/').pop());
      return response({ files: [] });
    },
  });
  const operation = sandbox.listFiles();
  await started;
  const cleanup = sandbox.destroy();
  finishCreation();
  await assert.rejects(operation, /sandbox destroyed/);
  await cleanup;
  assert.deepEqual(deleted, ['session-late']);
});

test('failed remote create can be retried, and nothing runs after destroy', async () => {
  let creations = 0;
  const deleted = [];
  const sandbox = createRemoteSandbox({
    baseUrl: 'https://sandbox.invalid', apiKey: 'test-key',
    fetchImpl: async (url, opts) => {
      if (opts.method === 'POST' && url.endsWith('/v1/sessions')) {
        creations += 1;
        return creations === 1 ? response({ error: 'docker_unavailable' }, 503)
          : response({ sessionId: 'session-retried' }, 201);
      }
      if (opts.method === 'DELETE') deleted.push(url.split('/').pop());
      return response({ files: [] });
    },
  });
  await assert.rejects(sandbox.listFiles(), /503/);
  assert.deepEqual(await sandbox.listFiles(), []);
  assert.equal(creations, 2);
  await sandbox.destroy();
  assert.deepEqual(deleted, ['session-retried']);
  await assert.rejects(sandbox.listFiles(), /sandbox destroyed/);
  await assert.rejects(sandbox.putFile('a.txt', Buffer.from('a')), /sandbox destroyed/);
});
