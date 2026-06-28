'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const runner = require('../src/services/github/workspace-runner.service');

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sira-run-'));
}

test('detectRunPlan: next project', async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { next: '14' }, scripts: { dev: 'next dev' } }),
    );
    const plan = runner.detectRunPlan(dir, 4321);
    assert.equal(plan.kind, 'node');
    assert.equal(plan.framework, 'next');
    assert.match(plan.command, /next dev -p 4321/);
    assert.match(plan.command, /npm install/); // no node_modules yet
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('detectRunPlan: vite project skips install when node_modules present', async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { vite: '5' }, scripts: { dev: 'vite' } }),
    );
    await fsp.mkdir(path.join(dir, 'node_modules'));
    const plan = runner.detectRunPlan(dir, 4400);
    assert.equal(plan.framework, 'vite');
    assert.match(plan.command, /vite --port 4400 --host 127\.0\.0\.1 --strictPort/);
    assert.ok(!/npm install/.test(plan.command), 'install skipped');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('detectRunPlan: custom dev script', async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
    const plan = runner.detectRunPlan(dir, 4500);
    assert.equal(plan.framework, 'custom-dev');
    assert.match(plan.command, /npm run dev/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('detectRunPlan: static site (index.html, no package.json)', async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(path.join(dir, 'index.html'), '<h1>hi</h1>');
    const plan = runner.detectRunPlan(dir, 4600);
    assert.equal(plan.kind, 'static');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('detectRunPlan: nothing runnable', async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(path.join(dir, 'README.md'), 'just docs');
    const plan = runner.detectRunPlan(dir, 4700);
    assert.equal(plan.kind, 'none');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('findFreePort returns a usable port in range', async () => {
  const port = await runner.findFreePort();
  assert.ok(port >= 4300 && port <= 4999, `port ${port} in range`);
});

test('status of unknown workspace is idle', () => {
  const s = runner.status('does-not-exist');
  assert.equal(s.running, false);
  assert.equal(s.status, 'idle');
});

test('normaliseRuntimeEnv keeps app env and rejects process overrides', () => {
  const env = runner.normaliseRuntimeEnv({
    openai_api_key: 'redacted',
    NEXT_PUBLIC_SITE_NAME: 'Sira',
    NODE_OPTIONS: '--require /tmp/evil.js',
    PATH: '/tmp/bin',
    'bad-key': 'x',
  });
  assert.equal(env.OPENAI_API_KEY, 'redacted');
  assert.equal(env.NEXT_PUBLIC_SITE_NAME, 'Sira');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PATH, undefined);
  assert.equal(env['BAD-KEY'], undefined);
});

test('isRuntimeEnvFile identifies runtime env files but not templates', () => {
  assert.equal(runner.isRuntimeEnvFile('.env'), true);
  assert.equal(runner.isRuntimeEnvFile('.env.development'), true);
  assert.equal(runner.isRuntimeEnvFile('.env.development.local'), true);
  assert.equal(runner.isRuntimeEnvFile('packages/app/.env.local'), true);
  assert.equal(runner.isRuntimeEnvFile('.env.sample'), false);
  assert.equal(runner.isRuntimeEnvFile('.env.production.example'), false);
});

test('static server starts, serves, and stops', async () => {
  const dir = await tmpDir();
  try {
    await fsp.writeFile(path.join(dir, 'index.html'), '<h1>hello-run</h1>');
    const started = await runner.start('test-conn', dir);
    assert.equal(started.kind, 'static');
    assert.equal(started.ready, true);

    const localUrl = new URL('/', `http://127.0.0.1:${started.port}`);
    const body = await new Promise((resolve, reject) => {
      const http = require('http');
      http
        .get(localUrl, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
    assert.match(body, /hello-run/);

    const stopped = runner.stop('test-conn');
    assert.equal(stopped.stopped, true);
    assert.equal(runner.status('test-conn').status, 'idle');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
