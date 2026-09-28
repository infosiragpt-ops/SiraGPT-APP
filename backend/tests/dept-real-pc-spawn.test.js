'use strict';

/**
 * dept-real-pc spawns the docker CLI. A spawn failure (CLI missing → ENOENT)
 * emits 'error' on the child; with no listener that was an uncaughtException
 * and index.js exits the backend with 1. runDocker / runDockerBuffer must
 * resolve a "command not found" result (127) instead.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dept = require('../src/services/codex/dept-real-pc');

let emptyDir;
let savedPath;
const uncaught = [];
const onUncaught = (err) => { uncaught.push(err); };

before(() => {
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dept-pc-nodocker-'));
  savedPath = process.env.PATH;
  process.env.PATH = emptyDir; // no docker binary anywhere on PATH
  process.on('uncaughtException', onUncaught);
});

after(() => {
  process.env.PATH = savedPath;
  process.removeListener('uncaughtException', onUncaught);
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

// Let any late 'error' / 'close' events fire before asserting.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('runDocker resolves {code:127} when the docker CLI cannot be spawned', async () => {
  const result = await dept.runDocker(['version'], { timeoutMs: 5_000 });
  assert.equal(result.code, 127);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'ENOENT');
  await settle();
  assert.deepEqual(uncaught, []);
});

test('runDockerBuffer resolves the same shape as its close path (Buffer stdout)', async () => {
  const result = await dept.runDockerBuffer(['version'], { timeoutMs: 5_000 });
  assert.equal(result.code, 127);
  assert.ok(Buffer.isBuffer(result.stdout));
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr, 'ENOENT');
  await settle();
  assert.deepEqual(uncaught, []);
});

test('inspectContainer survives a missing docker CLI (no process crash)', async () => {
  await dept.inspectContainer('sira-dpc-p1-d1').catch(() => null);
  await settle();
  assert.deepEqual(uncaught, []);
});
