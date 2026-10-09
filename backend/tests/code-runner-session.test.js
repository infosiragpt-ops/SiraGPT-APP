'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const HELPER = path.resolve(__dirname, '../../scripts/code-runner-session.js');

function startSession(root) {
  const child = spawn(process.execPath, [HELPER], {
    cwd: root,
    env: { ...process.env, SIRA_SESSION_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  lines.on('line', (line) => {
    const payload = JSON.parse(line);
    if (payload.type === 'ready') return ready(payload);
    const resolve = pending.get(payload.id);
    if (resolve) {
      pending.delete(payload.id);
      resolve(payload);
    }
  });
  let nextId = 1;
  return {
    child,
    async waitReady() { return readyPromise; },
    request(cmd) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ id, cmd })}\n`);
      });
    },
    close() {
      lines.close();
      child.kill('SIGTERM');
    },
  };
}

test('session supervisor persists cwd and filtered environment across commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-runner-session-'));
  await mkdir(path.join(root, 'nested'));
  const session = startSession(root);
  try {
    await session.waitReady();
    const cd = await session.request(['cd', 'nested']);
    assert.equal(cd.ok, true);
    const exported = await session.request(['export', 'SIRA_TEST_VALUE=persisted']);
    assert.deepEqual(exported.envKeys, ['SIRA_TEST_VALUE']);
    const observed = await session.request([
      'node',
      '-e',
      'process.stdout.write(`${process.cwd()}|${process.env.SIRA_TEST_VALUE}`)',
    ]);
    assert.equal(observed.ok, true);
    assert.equal(observed.stdout, `${path.join(root, 'nested')}|persisted`);
    const rejected = await session.request(['export', 'TOKEN=blocked']);
    assert.equal(rejected.error, 'invalid_env');
  } finally {
    session.close();
    await rm(root, { recursive: true, force: true });
  }
});
