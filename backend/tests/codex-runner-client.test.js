'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRunnerClient, RunnerError, runnerDevUrl, codexExportHostDir, codexExportHostPath } = require('../src/services/codex/runner-client');

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    return handler(calls[calls.length - 1]);
  };
  return { impl, calls };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('initWorkspace POSTs { project } to /workspace/init', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ ok: true, dir: 'projects/p1' }));
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  const out = await client.initWorkspace('p1');
  assert.equal(out.dir, 'projects/p1');
  assert.equal(calls[0].url, 'http://runner:4097/workspace/init');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { project: 'p1' });
});

test('exec POSTs { project, cmd, timeoutMs } and returns the runner payload verbatim', async () => {
  const payload = { ok: false, exitCode: 1, stdout: '', stderr: 'boom', durationMs: 12 };
  const { impl, calls } = fakeFetch(() => jsonResponse(payload));
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  const out = await client.exec('p1', ['git', 'status'], { timeoutMs: 5000 });
  assert.deepEqual(out, payload); // exit≠0 viaja como dato, no como excepción
  assert.deepEqual(calls[0].body, { project: 'p1', cmd: ['git', 'status'], timeoutMs: 5000 });
});

test('readFile URL-encodes project and path', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ ok: true, path: 'a b.txt', content: 'x' }));
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  await client.readFile('p1', 'src/a b.txt');
  assert.equal(calls[0].url, 'http://runner:4097/workspace/file?project=p1&path=src%2Fa%20b.txt');
});

test('non-2xx responses throw RunnerError with status and body', async () => {
  const { impl } = fakeFetch(() => jsonResponse({ error: 'invalid_project' }, 400));
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  await assert.rejects(() => client.initWorkspace('!!'), (err) => {
    assert.ok(err instanceof RunnerError);
    assert.equal(err.status, 400);
    assert.deepEqual(err.body, { error: 'invalid_project' });
    return true;
  });
});

test('network failures throw RunnerError with status 0', async () => {
  const impl = async () => { throw new Error('ECONNREFUSED'); };
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  await assert.rejects(() => client.devStatus(), (err) => {
    assert.ok(err instanceof RunnerError);
    assert.equal(err.status, 0);
    assert.match(err.message, /ECONNREFUSED/);
    return true;
  });
});

test('startDev posts { project, basePath } to /run; runnerDevUrl honours env override', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ ok: true, port: 5173, project: 'p1' }));
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  await client.startDev('p1');
  assert.equal(calls[0].url, 'http://runner:4097/run');
  assert.deepEqual(calls[0].body, { project: 'p1', basePath: null });
  await client.startDev('p1', { basePath: '/api/codex/projects/p1/preview/t/app/' });
  assert.deepEqual(calls[1].body, { project: 'p1', basePath: '/api/codex/projects/p1/preview/t/app/' });
  assert.equal(runnerDevUrl({ CODE_RUNNER_DEV_URL: 'https://preview.example' }), 'https://preview.example');
  assert.equal(runnerDevUrl({}), 'http://localhost:5173');
});

test('devStatus/stopDev propagate the project (multi-project runner) and keep the legacy no-arg shape', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ ok: true, running: false }));
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  await client.devStatus('p 1');
  assert.equal(calls[0].url, 'http://runner:4097/status?project=p%201');
  await client.devStatus();
  assert.equal(calls[1].url, 'http://runner:4097/status');
  await client.stopDev('p1');
  assert.deepEqual(calls[2].body, { project: 'p1' });
  await client.stopDev();
  assert.deepEqual(calls[3].body, {}); // legacy: stop ALL servers
});

test('runnerDevUrl swaps in a per-project pool port when given one', () => {
  assert.equal(runnerDevUrl({ CODE_RUNNER_DEV_URL: 'http://runner:5173' }, 5177), 'http://runner:5177');
  assert.equal(runnerDevUrl({}, 5180), 'http://localhost:5180');
  assert.equal(runnerDevUrl({ CODE_RUNNER_DEV_URL: 'http://runner:5173' }), 'http://runner:5173');
});

test('exportWorkspace POSTs { project } to /workspace/export', async () => {
  const { impl, calls } = fakeFetch(() => jsonResponse({ ok: true, project: 'p1', files: 7 }));
  const client = createRunnerClient({ fetchImpl: impl, baseUrl: 'http://runner:4097' });
  const out = await client.exportWorkspace('p1');
  assert.equal(out.files, 7);
  assert.equal(calls[0].url, 'http://runner:4097/workspace/export');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { project: 'p1' });
});

test('codexExportHostDir/Path default and honour env, picking the right separator', () => {
  assert.equal(codexExportHostDir({}), '.codex-workspaces');
  assert.equal(codexExportHostPath('p1', {}), '.codex-workspaces/p1');
  // POSIX override (trailing slash trimmed).
  assert.equal(codexExportHostPath('p1', { CODEX_EXPORT_HOST_DIR: '/srv/codex/' }), '/srv/codex/p1');
  // Windows override → backslash separator.
  assert.equal(codexExportHostPath('p1', { CODEX_EXPORT_HOST_DIR: 'D:\\git\\siraGPT\\.codex-workspaces' }), 'D:\\git\\siraGPT\\.codex-workspaces\\p1');
});
