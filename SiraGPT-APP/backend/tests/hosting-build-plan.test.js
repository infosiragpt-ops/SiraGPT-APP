'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const build = require('../src/services/hosting/build.service');

async function tmp() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sira-build-'));
}

test('detectBuildPlan: vite → npm run build, dist', async () => {
  const d = await tmp();
  try {
    await fsp.writeFile(path.join(d, 'package.json'), JSON.stringify({ devDependencies: { vite: '5' }, scripts: { build: 'vite build' } }));
    const plan = build.detectBuildPlan(d);
    assert.equal(plan.framework, 'vite');
    assert.match(plan.buildCommand, /npm run build/);
    assert.equal(plan.outputDir, 'dist');
  } finally {
    await fsp.rm(d, { recursive: true, force: true });
  }
})

test('detectBuildPlan: next → out', async () => {
  const d = await tmp();
  try {
    await fsp.writeFile(path.join(d, 'package.json'), JSON.stringify({ dependencies: { next: '14' }, scripts: { build: 'next build' } }));
    const plan = build.detectBuildPlan(d);
    assert.equal(plan.framework, 'next')
    assert.equal(plan.outputDir, 'out')
  } finally {
    await fsp.rm(d, { recursive: true, force: true });
  }
})

test('detectBuildPlan: static index.html, no package.json', async () => {
  const d = await tmp();
  try {
    await fsp.writeFile(path.join(d, 'index.html'), '<h1>hi</h1>');
    const plan = build.detectBuildPlan(d);
    assert.equal(plan.kind, 'static');
    assert.equal(plan.buildCommand, null);
    assert.equal(plan.outputDir, '.');
  } finally {
    await fsp.rm(d, { recursive: true, force: true });
  }
})

test('resolveOutputDir: prefers existing hint, else known candidates', async () => {
  const d = await tmp();
  try {
    await fsp.mkdir(path.join(d, 'build'));
    await fsp.writeFile(path.join(d, 'build', 'index.html'), 'x');
    // hint dist does not exist → falls back to build
    assert.equal(build.resolveOutputDir(d, 'dist'), 'build');
    // '.' hint stays '.'
    assert.equal(build.resolveOutputDir(d, '.'), '.');
  } finally {
    await fsp.rm(d, { recursive: true, force: true });
  }
})

test('runBuild: static (no command) resolves skipped', async () => {
  const logs = [];
  const r = await build.runBuild('/nonexistent', { buildCommand: null, onLog: (l) => logs.push(l) });
  assert.equal(r.skipped, true);
  assert.ok(logs.join(' ').includes('static'));
})
