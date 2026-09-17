'use strict';

// Next.js preview under the tokenized basePath: the runner writes a
// next.config.js wrapper (Next ignores `conf` for dev routing).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const utils = require('../../scripts/code-runner-utils.js');

test('normalizeNextBasePath strips the trailing slash and rejects unsafe values', () => {
  assert.equal(utils.normalizeNextBasePath('/api/codex/projects/p1/preview/tok/app/'), '/api/codex/projects/p1/preview/tok/app');
  assert.equal(utils.normalizeNextBasePath('/'), '');
  assert.equal(utils.normalizeNextBasePath(''), '');
  assert.equal(utils.normalizeNextBasePath('api/x'), '');
  assert.equal(utils.normalizeNextBasePath('/a/../b'), '');
  assert.equal(utils.normalizeNextBasePath("/a'b"), '');
});

test('planNextPreviewConfig: user next.config.ts/mjs are wrapped in place; next.config.js is moved aside once', () => {
  assert.deepEqual(utils.planNextPreviewConfig({ existing: ['next.config.ts'] }), { userConfig: 'next.config.ts', rename: null });
  assert.deepEqual(utils.planNextPreviewConfig({ existing: ['next.config.mjs'] }), { userConfig: 'next.config.mjs', rename: null });
  assert.deepEqual(utils.planNextPreviewConfig({ existing: [] }), { userConfig: null, rename: null });
  assert.deepEqual(utils.planNextPreviewConfig({ existing: ['next.config.js'] }), { userConfig: 'next.config.siragpt-user.js', rename: ['next.config.js', 'next.config.siragpt-user.js'] });
  // second start: our wrapper is already there, the user file lives in the backup
  assert.deepEqual(utils.planNextPreviewConfig({ existing: ['next.config.js'], wrapperIsOurs: true, backupExists: true }), { userConfig: 'next.config.siragpt-user.js', rename: null });
  // second start for a .ts project: wrapper + user ts both present
  assert.deepEqual(utils.planNextPreviewConfig({ existing: ['next.config.js', 'next.config.ts'], wrapperIsOurs: true }), { userConfig: 'next.config.ts', rename: null });
});

test('buildNextPreviewWrapper produces a loadable config that merges the user config and adds basePath', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-preview-'));
  fs.writeFileSync(path.join(dir, 'next.config.siragpt-user.js'), "module.exports = { reactStrictMode: true, allowedDevOrigins: ['dev.local'] };\n");
  const src = utils.buildNextPreviewWrapper({
    basePath: '/api/codex/projects/p1/preview/tok/app/',
    userConfig: 'next.config.siragpt-user.js',
    allowedOrigins: ['https://siragpt.com', 'www.siragpt.com', 'bad origin'],
  });
  assert.match(src, /SIRAGPT_NEXT_PREVIEW_WRAPPER/);
  const wrapperPath = path.join(dir, 'next.config.js');
  fs.writeFileSync(wrapperPath, src);
  const mod = require(wrapperPath);
  const conf = await mod('phase-development-server', { defaultConfig: {} });
  assert.equal(conf.basePath, '/api/codex/projects/p1/preview/tok/app');
  assert.equal(conf.assetPrefix, '/api/codex/projects/p1/preview/tok/app');
  assert.equal(conf.reactStrictMode, true);
  assert.deepEqual(conf.allowedDevOrigins, ['dev.local', 'runner', '127.0.0.1', 'localhost', 'siragpt.com', 'www.siragpt.com']);
  assert.throws(() => utils.buildNextPreviewWrapper({ basePath: '' }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrapper references only whitelisted user config names', () => {
  const src = utils.buildNextPreviewWrapper({ basePath: '/x', userConfig: '../../etc/passwd' });
  assert.match(src, /const USER_CONFIG = null;/);
  // eslint-disable-next-line no-new
  new vm.Script(src);
});

test('runner wires the wrapper before `next dev` and excludes it from git', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'code-runner.js'), 'utf8');
  const prep = src.indexOf('function prepareNextPreviewConfig(');
  const use = src.indexOf('prepareNextPreviewConfig(projectId, cwd, entry.basePath, entry)');
  const nextCmd = src.indexOf('"node_modules/next/dist/bin/next", "dev"');
  assert.ok(prep > 0 && use > prep && nextCmd > use, 'wrapper is written before the next dev command');
  assert.match(src, /\.git\/info\/exclude/);
  assert.match(src, /CODE_RUNNER_PREVIEW_ALLOWED_ORIGINS/);
});
